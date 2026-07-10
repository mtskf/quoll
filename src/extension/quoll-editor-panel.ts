// Custom editor provider for *.md files.
//
// The host-session STATE MACHINE — write-lock ordering, the rejected-draft
// barrier, the resync rules, and the applyEdit settlement — lives in the
// pure reducer `src/extension/host-session-core.ts`. This file is the VS
// Code wiring around it: it snapshots live VS Code inputs
// (`document.version`, `canWriteNow()`, canonical text, theme) into core
// EVENTS, runs the returned EFFECTS as real side effects, and feeds async
// outcomes (applyEdit settlement, edit-rejected delivery failure) back into
// the core via a queued, non-recursive `dispatch`. See host-session-core.ts
// for the transition table; the rationale below covers only why each piece
// of VS Code wiring is shaped the way it is.
//
//   - `disposed` (local) — set on webviewPanel.onDidDispose. Every async
//     continuation (the applyEdit / edit-rejected `.then` arms, listener
//     callbacks) checks it synchronously before touching the webview, so a
//     dispose that races with an in-flight Promise does not postMessage on a
//     disposed webview and unhandled-reject. The core also tracks a
//     `disposed` STATE as the decision authority; this local short-circuits
//     effect delivery (the two are kept in lockstep by onDidDispose).
//
// Hidden-webview resync: webviewPanel.onDidChangeViewState fires when the
// panel transitions between visible / hidden / focused. Dispatching
// `viewStateVisible` on the visible-edge lets the core repost the
// authoritative Document so edits made via the default text editor while the
// rich editor was hidden land in the webview as soon as it becomes visible.

import type {
  CancellationToken,
  CustomTextEditorProvider,
  ExtensionContext,
  Tab,
  TextDocument,
  TextEditor,
  Webview,
  WebviewPanel,
} from "vscode";
import {
  ColorThemeKind,
  commands,
  Disposable,
  env,
  languages,
  Position,
  Range,
  RelativePattern,
  Selection,
  TabInputCustom,
  TabInputText,
  TabInputTextDiff,
  Uri,
  ViewColumn,
  WorkspaceEdit,
  window,
  workspace,
} from "vscode";

import { createIncrementalWriteValidator } from "../markdown/validate-for-write.js";
import { perfReport } from "../shared/perf.js";
import { isWebviewToHost } from "../shared/protocol.js";
import { canHostWrite } from "./can-host-write.js";
import { type Caret, clampCaret } from "./caret-handoff.js";
import { createDirtyDocConflictWatcher } from "./dirty-doc-conflict-watcher.js";
import {
  DISK_CONFLICT_KEEP,
  DISK_CONFLICT_MESSAGE,
  DISK_CONFLICT_RELOAD,
} from "./disk-conflict.js";
import { buildDocumentMessageFromDocument, canonicalDocumentText } from "./document-canonical.js";
import { createTrailingDebounce } from "./document-change-debounce.js";
import {
  buildCaretApplyMessage,
  buildDocumentMessage,
  buildEditorConfigMessage,
  buildEditRejectedMessage,
  buildImageWriteResultMessage,
  buildThemeMessage,
} from "./document-message.js";
import { createEditSettledBarrier } from "./edit-settled-barrier.js";
import { takeSwitchCaret } from "./editor-switch-caret.js";
import { createEffectExecutor } from "./effect-executor.js";
import { getNonce } from "./get-nonce.js";
import { handleCodexContextHandoff } from "./handle-codex-context-handoff.js";
import { handleContextHandoff } from "./handle-context-handoff.js";
import { handleOpenExternal } from "./handle-open-external.js";
import { handleOpenLink } from "./handle-open-link.js";
import {
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEvent,
  isWriteLockHeld,
} from "./host-session-core.js";
import { handleImageWrite } from "./image-write-service.js";
import { toLintDiagnostics } from "./lint-diagnostics.js";
import { LintMirror } from "./lint-mirror.js";
import { minimalEditSpan } from "./minimal-edit.js";
import { openInQuollEditor } from "./open-in-quoll.js";
import { openInTextEditor } from "./reopen-text-editor.js";
import { createRevertRescueTracker } from "./revert-rescue.js";
import {
  decideRevealInvariant,
  planRevealTabClose,
  type RevealCleanupGroup,
} from "./reveal-for-mention-cleanup.js";
import type { PanelControls, TestHarness } from "./test-harness.js";
import {
  buildLocalResourceRoots,
  buildResourceBaseUri,
  buildWebviewAssetUris,
} from "./webview-assets.js";
import { buildWebviewHtml } from "./webview-html.js";

// Full dotted id of the setting that gates the host→Problems lint mirror.
// `affectsConfiguration` matches on this exact key.
const LINT_MIRROR_CONFIG_KEY = "quoll.lint.problems.enabled";

function readLintMirrorEnabled(): boolean {
  return workspace.getConfiguration().get<boolean>(LINT_MIRROR_CONFIG_KEY, true);
}

// `affectsConfiguration` matches on this exact key.
const LINT_GUTTER_CONFIG_KEY = "quoll.lint.gutter.enabled";

function readLintGutterEnabled(): boolean {
  return workspace.getConfiguration().get<boolean>(LINT_GUTTER_CONFIG_KEY, false);
}

// `affectsConfiguration` matches on this exact key.
const SPELLCHECK_CONFIG_KEY = "quoll.editor.spellcheck";

function readSpellcheckEnabled(): boolean {
  return workspace.getConfiguration().get<boolean>(SPELLCHECK_CONFIG_KEY, true);
}

/** Trailing-debounce window for coalescing LOCK-FREE external-edit
 *  `documentChanged` dispatches. ~100 ms: long enough to collapse the sub-ms
 *  bursts that dominate the cost (formatter, git checkout, an AI tool writing
 *  the open file) into one Document repost, short enough that a lone external
 *  edit still propagates promptly. Normal split-editor typing (~150 ms/char)
 *  exceeds this window, so each keystroke propagates on its pause. */
const DOC_CHANGE_DEBOUNCE_MS = 100;

export class QuollEditorPanel implements CustomTextEditorProvider {
  public static register(context: ExtensionContext, harness?: TestHarness): Disposable {
    return window.registerCustomEditorProvider(
      QuollEditorPanel.viewType,
      new QuollEditorPanel(context, harness),
      {
        supportsMultipleEditorsPerDocument: false,
        // Preserve the webview's CodeMirror state across hide / show
        // cycles. Otherwise (default `false`) a hidden panel is
        // destroyed and re-created — defeating the visible-edge resync
        // suppression AND erasing the user's typed-but-rejected content
        // the instant they switch tabs. Memory cost is per-open-Markdown,
        // acceptable for a Markdown editor.
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
  }

  // Project identity — preserved across the cutover. Changing this breaks
  // user keybindings, editor associations, and the activationEvents entry.
  public static readonly viewType = "quoll.editMarkdown";

  // ONE provider-owned mirror for the whole custom editor, keyed per
  // document.uri. Advisory lint mirror only — write-gate failures never enter
  // it (they ride the edit-rejected/toast path). The underlying
  // DiagnosticCollection is registered for disposal on extension deactivate;
  // each panel clears only ITS uri on dispose (below), so multiple open
  // documents never interfere.
  private readonly lintMirror: LintMirror;

  constructor(
    private readonly context: ExtensionContext,
    private readonly harness?: TestHarness
  ) {
    const collection = languages.createDiagnosticCollection("quoll");
    context.subscriptions.push(collection);
    this.lintMirror = new LintMirror(collection, readLintMirrorEnabled());
    // Re-push the flag when the user toggles the setting. Disabling clears the
    // Problems panel; enabling re-populates open documents from cache. The
    // webview lint layer (underlines) is unaffected — it never reads this.
    context.subscriptions.push(
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(LINT_MIRROR_CONFIG_KEY)) {
          this.lintMirror.setEnabled(readLintMirrorEnabled());
        }
      })
    );
  }

  resolveCustomTextEditor(
    document: TextDocument,
    webviewPanel: WebviewPanel,
    _token: CancellationToken
  ): void | Thenable<void> {
    const extensionUri = this.context.extensionUri;

    webviewPanel.webview.options = {
      enableScripts: true,
      // dist/webview/ (bundle) + the document's folder for file-scheme docs
      // (relative-image read path). VS Code blocks any resource outside these
      // roots, so a same-folder image (./img.png, ./sub/img.png) loads but a
      // parent-relative / workspace-shared image (../assets/img.png) does NOT —
      // it resolves to a valid URI yet VS Code refuses the fetch (broken-image
      // icon). This minimal widening is intentional; broadening to the
      // workspace folder is a separate, security-reviewed follow-up. See
      // buildLocalResourceRoots for the non-file (bundle-only) branch.
      localResourceRoots: buildLocalResourceRoots(extensionUri, document),
    };

    // showError centralises window.showErrorMessage with rejection handling.
    // Hoisted above the try/catch below so the catch arm can reuse it instead
    // of inlining a `void window.showErrorMessage(...)` that would silently
    // swallow toast rejections — the same asymmetry showError closes for every
    // other call site below (grep `showError(` for the full set).
    const showError = (message: string): void => {
      this.harness?.recordError(message);
      void window.showErrorMessage(message).then(undefined, (err: unknown) => {
        console.error("[quoll] showErrorMessage rejected", err);
      });
    };

    // Reverse editor-switch caret restore (one-shot). A text-editor→Quoll switch
    // (quoll.toggleEditor) stashed the caret under this uri just before creating
    // THIS panel; take it (clearing the store — consumed regardless of whether
    // construction below succeeds) and apply it once at `ready`, after the seed
    // Document. null when this panel was not opened via a switch.
    const switchCaret = takeSwitchCaret(document.uri.toString());
    let switchCaretApplied = false;

    try {
      // Test seam: buildWebviewHtmlOverride (when set) lets the E2E suite
      // force a build failure so the catch arm below is pinned. Production
      // builds construct no harness, so this is always the real builder.
      webviewPanel.webview.html = this.harness?.buildWebviewHtmlOverride
        ? this.harness.buildWebviewHtmlOverride()
        : QuollEditorPanel.getWebviewContent(webviewPanel.webview, extensionUri, document);
    } catch (err) {
      // getWebviewContent / buildWebviewHtml throws on bad cspSource / nonce /
      // scriptUri / stylesUri (defense-in-depth validators in
      // src/extension/webview-html.ts). Without this catch the throw escapes
      // resolveCustomTextEditor: the webview HTML never gets set, none of the
      // listeners below are wired, and the user sees a silent blank editor.
      // showError keeps parity with every other showError call site below —
      // each one logs the failure AND observes the toast rejection rather
      // than dropping it silently.
      console.error("[quoll] failed to build webview HTML", err);
      showError("Quoll: failed to initialise the editor. See the extension host log for details.");
      return;
    }

    const disposables: Disposable[] = [];
    // Dispose-safety flag. applyEdit / postMessage return Thenables that
    // can settle after onDidDispose has fired (Promise microtask vs
    // synchronous dispose). Every async continuation + listener checks
    // `disposed` before touching the webview to avoid postMessage-after-
    // dispose. The core also tracks `disposed` STATE as the decision
    // authority; this local short-circuits effect delivery (kept in
    // lockstep by onDidDispose, which sets it before dispatching).
    let disposed = false;

    // Single-flight guard for the Codex handoff. A rapid ⌘+J repeat within the
    // async window would add a DUPLICATE, persistent context chip to the Codex
    // sidebar (unlike Claude's transient terminal echo). Reset in the handler's
    // .finally below.
    let codexHandoffInFlight = false;

    // ONE per-panel last-known caret (0-based, VS Code Position convention).
    // Single panel per document, so no Map. Written by BOTH the webview
    // caret-report (Quoll active) and onDidChangeTextEditorSelection (text
    // editor active); applied on the activation edge to whichever surface the
    // user switches INTO. null until the first report — nothing to carry yet.
    let lastKnownCaret: Caret | null = null;

    // Revert-rescue: VS Code core reverts the shared working copy when THIS
    // custom editor tab is closed via "Don't Save", even while a built-in text
    // editor for the same resource stays open (CustomEditorInput never matches
    // the text editor's FileEditorInput, so core thinks we are the last holder
    // of the dirty state — see the dispose handler below + docs/LEARNING.md).
    // CustomTextEditorProvider has no hook to PREVENT that revert, so we REPAIR
    // it on dispose. Seed with the current snapshot: the document can be dirty
    // BEFORE Quoll opens (the reported bug), and onDidChangeTextDocument never
    // fires for that pre-existing dirty content. Raw getText() (not
    // canonicalised) — VS Code owns this document's EOL and we read+write it.
    const revertRescue = createRevertRescueTracker();
    revertRescue.observe({ isDirty: document.isDirty, content: document.getText(), at: Date.now() });
    // Active-edge tracker for the panel. onDidChangeViewState fires on
    // visible/active/focus changes; the caret apply must fire ONCE per
    // inactive→active transition, not on every event. Seeded from the panel's
    // current active state so the first event does not read a false edge.
    let wasActive = webviewPanel.active;

    // The pure host-session reducer owns every state mutation (write-lock
    // ordering, rejected-draft barrier, resync rules, settlement). This
    // file snapshots live VS Code inputs into EVENTS and runs the returned
    // EFFECTS; see host-session-core.ts for the transition table.
    const core = createHostSessionCore(
      {
        uriString: document.uri.toString(),
        fsPath: document.uri.fsPath,
      },
      // Per-panel incremental write validator: reuses the previous parse via
      // Lezer TreeFragment so a debounced flush re-parses only the changed
      // span. Verdict-identical to the stateless default (pinned by a fuzz
      // battery); the cache lives in this closure, reclaimed once the panel
      // closure is no longer held (past dispose by at most one async settlement).
      { validateForWrite: createIncrementalWriteValidator() }
    );
    let state = core.initialState(document.version);

    // Edit-applied barrier for the document side channels (context-handoff /
    // codex-context-handoff / switch-to-text). It DEFERS a side-channel thunk
    // while the host write lock is held (a flushed edit is still applying —
    // PR #54 flush-before-post + VS Code's non-serialised async handlers) and
    // drains it once a SUCCESSFUL settlement releases the lock, so the handoff
    // reads the APPLIED document rather than the pre-edit snapshot. On a FAILED
    // apply the deferred thunk is dropped (no valid post-edit state). Reads the
    // reducer's published lock state ONLY (isWriteLockHeld); the side channels
    // never enter the reducer.
    const editSettledBarrier = createEditSettledBarrier({
      isLocked: () => isWriteLockHeld(state),
      isDisposed: () => disposed,
    });

    // Queued, non-recursive dispatch. `step` runs one transition + its
    // effects + the state mutation; the unit-tested createDrainingDispatcher
    // owns the queue + draining guard, so a re-entrant feedback dispatch (an
    // effect that re-enters the core — applyEdit settlement, edit-rejected
    // delivery failure, construct/apply sync-throw) is flat / FIFO rather
    // than a recursive stack. `dispatch` is declared with definite-assignment
    // so the effect executors below can close over it — they are only invoked
    // once a dispatch is in flight, after this assignment.
    let dispatch!: (event: HostSessionEvent) => void;
    const step = (event: HostSessionEvent): void => {
      const result = core.transition(state, event);
      state = result.state;
      runEffects(result.effects);
      // Drain any side channel deferred behind the write lock once a SUCCESSFUL
      // settlement has released it. `applied` is false only for a FAILED apply
      // settlement — then the deferred thunk is dropped (the edit never landed,
      // so it would read pre-edit state). Placed AFTER runEffects so a
      // settlement that re-acquires the lock via the stash drain (its
      // `applyEdit` effect ran above, re-setting the lock in `state`) keeps the
      // barrier deferred. Side channels are async (`void handle…` /
      // `void openInTextEditor…`) and do not synchronously re-enter dispatch, so
      // this cannot recurse into the active drain loop; the barrier also
      // isolates any synchronous thunk throw via onError.
      const editApplied = !(event.type === "applyEditSettled" && event.outcome.kind !== "ok");
      editSettledBarrier.settle(editApplied);
    };
    dispatch = createDrainingDispatcher<HostSessionEvent>(step);

    // canWriteNow gates host-side writes to on-disk file: documents only
    // (see src/extension/can-host-write.ts). Re-checked at post time so
    // a runtime filesystem flip (read-only mount) is reflected on the
    // next Document push.
    const canWriteNow = (): boolean =>
      canHostWrite(document.uri.scheme, (scheme) => workspace.fs.isWritableFileSystem(scheme));

    // Effect executor — owns `post`, `sendEditRejected`, `runApplyEdit`, and
    // `runEffects` (extracted to src/extension/effect-executor.ts so the
    // dispose / lifecycle branches get direct unit tests). It stays vscode-free:
    // every VS Code touch (postMessage surface, WorkspaceEdit build/apply,
    // document text/version, theme/canWrite reads, handleOpenExternal, the
    // message builders) is injected here. The builders are closures that read
    // live theme/canWrite at CALL time, preserving the freshness contract.
    const { post, runEffects } = createEffectExecutor({
      isDisposed: () => disposed,
      getState: () => state,
      uriString: () => document.uri.toString(),
      dispatch: (event) => dispatch(event),
      // Route postMessage through the harness override when present so tests can
      // exercise the non-acceptance arms (ok=false / reject). Production builds
      // construct no harness, so the override is undefined and the real webview
      // surface is used directly. LAZY: `this.harness?.webviewPostMessageOverride`
      // is re-read on every send — the E2E harness swaps the override PER TEST
      // (after this panel is constructed), so an eagerly-captured surface would
      // pin the construction-time binding and ignore the swap (pinned by the
      // edit-rejected / resync-fallback e2e).
      send: (m) =>
        (
          this.harness?.webviewPostMessageOverride ?? ((mm) => webviewPanel.webview.postMessage(mm))
        )(m),
      recordEvent: (m) => this.harness?.recordEvent(m),
      showError,
      canWrite: canWriteNow,
      buildSeedDocument: (docVersion) =>
        buildDocumentMessageFromDocument(document, {
          docVersion,
          isDarkTheme: window.activeColorTheme.kind === ColorThemeKind.Dark,
          canWrite: canWriteNow(),
        }),
      buildRejectedDraft: (content, docVersion) =>
        buildDocumentMessage({
          content,
          docVersion,
          isDarkTheme: window.activeColorTheme.kind === ColorThemeKind.Dark,
          canWrite: canWriteNow(),
        }),
      buildTheme: (isDarkTheme) => buildThemeMessage(isDarkTheme),
      buildEditRejected: (error) => buildEditRejectedMessage(error),
      applyEditSeam: {
        // OLD text = the live buffer (applyEdit has not run yet, and the write
        // lock — set by the accept transition — blocks any other inbound edit on
        // the synchronous dispatch chain).
        readText: () => document.getText(),
        readVersion: () => document.version,
        readCanonical: () => canonicalDocumentText(document),
        build: (span) => {
          // positionAt clamps out-of-range offsets (never throws) and
          // minimalEditSpan is pure — so a build throw stays unreachable in
          // practice; the seam's constructThrew arm is preserved for parity.
          const edit = new WorkspaceEdit();
          edit.replace(
            document.uri,
            new Range(document.positionAt(span.from), document.positionAt(span.to)),
            span.insert
          );
          return edit;
        },
        apply: (edit) =>
          this.harness?.applyEditOverride
            ? this.harness.applyEditOverride(edit as WorkspaceEdit)
            : workspace.applyEdit(edit as WorkspaceEdit),
      },
      // `openExternalOverride` (when set) bypasses Uri.parse so the open-external
      // E2E test can pin the delegation contract without depending on the real
      // `env` binding — the test process cannot spy on `env.openExternal` through
      // the vscode module namespace. The override sees the gated href as a plain
      // string; same surface as the production closure.
      openExternal: (href) =>
        handleOpenExternal(href, {
          openExternal:
            this.harness?.openExternalOverride ?? ((url) => env.openExternal(Uri.parse(url))),
          showError,
        }),
    });

    // Editor-surface config push (side channel, NOT through the host-session
    // core — the gutter flag is independent of document/edit lifecycle). Sent
    // at seed + ready (so it lands regardless of which handshake wins) and on
    // every relevant onDidChangeConfiguration. Idempotent: a duplicate is a
    // harmless no-op compartment reconfigure webview-side.
    const postEditorConfig = (): void => {
      post(buildEditorConfigMessage(readLintGutterEnabled(), readSpellcheckEnabled()));
    };

    // Image-write executor. Orthogonal to the document-text write lock (it writes
    // a SEPARATE binary file, not the TextDocument), so it does NOT enter the
    // host-session core. writeImage creates <docFolder>/assets/ then writes — the
    // explicit createDirectory removes any dependency on writeFile's
    // (undocumented) parent-dir behaviour and is idempotent. canWriteNow() is the
    // read-only guard (defense in depth: the webview also drops paste on
    // !canWrite).
    const runImageWrite = (requestId: string, data: string): void => {
      void handleImageWrite(
        {
          canWrite: canWriteNow,
          showError,
          postResult: (id, relativePath) => post(buildImageWriteResultMessage(id, relativePath)),
          writeImage: async (filename, bytes) => {
            const assetsDir = Uri.joinPath(document.uri, "..", "assets");
            await workspace.fs.createDirectory(assetsDir);
            const target = Uri.joinPath(assetsDir, filename);
            const write: (uri: Uri, content: Uint8Array) => Thenable<void> =
              this.harness?.writeImageFileOverride ??
              ((uri, content) => workspace.fs.writeFile(uri, content));
            await write(target, bytes);
            return `./assets/${filename}`;
          },
        },
        requestId,
        data
      );
    };

    // Apply lastKnownCaret to a live text editor for the same document. Clamps
    // to the editor's current document (the webview measured the caret against
    // a possibly-different snapshot) via the pure clampCaret, then sets the
    // selection and reveals it. Echo: setting `editor.selection` fires
    // onDidChangeTextEditorSelection with the SAME (clamped) value, so no flag
    // is needed host-side — the re-store is idempotent.
    //
    // BEST-EFFORT (Codex #3): there is no doc epoch on the caret. If the user
    // typed in Quoll and switched to the text editor inside edit-sync's 300 ms
    // debounce (before the Edit flushed to the TextDocument), the caret was
    // measured against newer content than this TextDocument holds, so the
    // applied position can be off by the un-flushed delta. The clamp guarantees
    // a VALID position (never out of bounds); the residual skew is an accepted
    // limitation of a one-shot handoff with a flat {line, character} state.
    const applyCaretToTextEditor = (editor: TextEditor, caret: Caret): void => {
      const doc = editor.document;
      const clamped = clampCaret(caret, doc.lineCount, (line) => doc.lineAt(line).text.length);
      const pos = new Position(clamped.line, clamped.character);
      editor.selection = new Selection(pos, pos);
      editor.revealRange(new Range(pos, pos));
    };

    // Coalesce a burst of LOCK-FREE external-edit events (formatter, git
    // checkout, an AI tool writing the open file, typing in a split text editor
    // on the same doc) into ONE trailing `documentChanged` dispatch. Each
    // dispatch reposts the full Document, which forces a wholesale webview
    // re-parse + block-field recompute + re-lint; without this, that runs once
    // PER change event.
    //
    // The fire thunk reads `document.version` LIVE (latest-wins): staleness
    // detection is unaffected because the `edit` arm snapshots the live version
    // itself, and the reducer's version-identical no-op guard + write-lock
    // deferral both hold at the (possibly settled) fire-time version. A trailing
    // fire that lands after a superseding immediate dispatch / settlement reads
    // an already-synced version and the reducer no-ops it; a trailing fire that
    // lands WHILE the lock is still held is deferred by the reducer
    // (pendingApplyBaseVersion), and the settlement then reposts the
    // authoritative version (ok overrides lastAppliedDocVersion, refused reposts
    // the fire-thunk-synced version) — both harmless.
    //
    // TRADE-OFF (recorded): this widens the window in which the webview still
    // holds the pre-edit baseDocVersion by up to DOC_CHANGE_DEBOUNCE_MS. A
    // webview edit typed in that window is judged stale by the `edit` arm's live
    // resync and reseeded to the external content (external wins — intended
    // conflict semantics; at most one local edit BURST — every keystroke typed
    // within the window, already coalesced by the webview's own edit-sync
    // debounce — is lost, then the reseed lands). No pure trailing debounce
    // `maxWait`: sustained sub-100ms same-doc typing in a split editor defers
    // the Quoll update until a pause (follow-up, not this PR).
    //
    // Hidden-panel suppression is DECLINED for this PR (1 PR = 1 purpose): with
    // `retainContextWhenHidden` this still reposts to a hidden panel, redundant
    // with the visible-edge resync, but suppressing it would let the host→
    // Problems lint mirror go stale while hidden — a separate freshness-contract
    // change with its own tests. Possible follow-up.
    const scheduleDocumentChanged = createTrailingDebounce(DOC_CHANGE_DEBOUNCE_MS, () => {
      if (disposed) {
        return;
      }
      dispatch({ type: "documentChanged", documentVersion: document.version });
    });
    workspace.onDidChangeTextDocument(
      (e) => {
        if (disposed) {
          return;
        }
        if (e.document.uri.toString() !== document.uri.toString()) {
          return;
        }
        // Feed the revert-rescue tracker every transition (see the dispose
        // handler). Raw getText() — no per-keystroke canonicalise.
        revertRescue.observe({
          isDirty: e.document.isDirty,
          content: e.document.getText(),
          at: Date.now(),
        });
        // Lock-held change events go to the reducer IMMEDIATELY, unchanged: the
        // host's OWN in-flight apply fires its change event under the lock, and
        // an external edit racing the apply→settle window also arrives locked.
        // The reducer owns the write-lock deferral + non-OK settlement ordering
        // contract and must see these in order (a refused settlement keeps the
        // prior lastAppliedDocVersion, so a delayed racing-edit resync would
        // post stale-versioned content). Only lock-FREE external bursts coalesce.
        if (isWriteLockHeld(state)) {
          // Supersede any pending coalesced timer: the immediate dispatch
          // carries an equal-or-higher version, so a later trailing fire would
          // only no-op. Cancelling makes "at most one pending documentChanged
          // path" an invariant rather than leaning on the fire-time no-op.
          scheduleDocumentChanged.cancel();
          dispatch({ type: "documentChanged", documentVersion: e.document.version });
          return;
        }
        scheduleDocumentChanged.schedule();
      },
      undefined,
      disposables
    );

    window.onDidChangeActiveColorTheme(
      (e) => {
        if (disposed) {
          return;
        }
        dispatch({ type: "themeChanged", isDarkTheme: e.kind === ColorThemeKind.Dark });
      },
      undefined,
      disposables
    );

    // Track the caret while the DEFAULT text editor for this document is the
    // ACTIVE editor, so a text-editor→Quoll switch carries it. Two guards:
    //   - uri match keeps unrelated editors out.
    //   - `window.activeTextEditor === e.textEditor` (Codex #4) ignores a
    //     selection change in a NON-active split / a programmatic selection set
    //     by another extension on the same uri — only the editor the user is
    //     actually in should define the caret to carry.
    // Pure side channel — never the reducer.
    window.onDidChangeTextEditorSelection(
      (e) => {
        if (disposed) {
          return;
        }
        if (e.textEditor.document.uri.toString() !== document.uri.toString()) {
          return;
        }
        if (window.activeTextEditor !== e.textEditor) {
          return;
        }
        const active = (e.selections[0] ?? e.textEditor.selection).active;
        lastKnownCaret = { line: active.line, character: active.character };
      },
      undefined,
      disposables
    );

    // Quoll→text-editor handoff: when the default text editor for THIS document
    // becomes the active editor, apply lastKnownCaret to it. A custom editor is
    // not a TextEditor, so switching INTO Quoll surfaces here as `undefined`
    // (ignored); switching into the text editor surfaces as a matching-uri
    // editor. Asymmetry is load-bearing — the reverse direction rides
    // onDidChangeViewState below.
    window.onDidChangeActiveTextEditor(
      (editor) => {
        if (disposed || !editor) {
          return;
        }
        if (editor.document.uri.toString() !== document.uri.toString()) {
          return;
        }
        if (lastKnownCaret === null) {
          return;
        }
        applyCaretToTextEditor(editor, lastKnownCaret);
      },
      undefined,
      disposables
    );

    // Per-panel editor-config push on a relevant settings change. Side
    // channel (does NOT enter the host-session core); disposed with the panel.
    workspace.onDidChangeConfiguration(
      (e) => {
        if (disposed) {
          return;
        }
        if (
          e.affectsConfiguration(LINT_GUTTER_CONFIG_KEY) ||
          e.affectsConfiguration(SPELLCHECK_CONFIG_KEY)
        ) {
          postEditorConfig();
        }
      },
      undefined,
      disposables
    );

    // Hidden-webview resync (visible) + caret handoff (active edge).
    //   - Visible: UNCHANGED from the prior implementation — when the panel is
    //     visible, the core reposts the current authoritative Document so edits
    //     made via the default text editor (while the rich editor was hidden)
    //     land immediately. Deliberately NOT edge-gated (preserves existing
    //     resync semantics; edge-gating is out of this PR's scope — Codex #1).
    //   - Active edge: when the panel transitions inactive→active, push
    //     lastKnownCaret as a one-shot caret-apply so the caret the user left
    //     in the text editor lands in Quoll. `wasActive` makes this fire ONCE
    //     per inactive→active transition, not on every visible/focus event.
    // ORDERING: post(caret-apply) AFTER dispatch(viewStateVisible). The
    // dispatcher drains SYNCHRONOUSLY (createDrainingDispatcher), so when
    // viewStateVisible posts a Document it reaches webview.postMessage BEFORE
    // this caret-apply → the webview applies the Document first, then the caret
    // (FIFO). In the rare deferred-Document edge (write-lock held / rejection
    // pending → no Document posted now), caret-apply lands first; a later
    // reseed re-captures the CURRENT selection in applyDocument (prevSelection),
    // so the carried caret survives (clamped) — same mid-edit-reseed class
    // already handled there (Codex #2, verified by the side-effect review).
    webviewPanel.onDidChangeViewState(
      (e) => {
        if (disposed) {
          return;
        }
        const panel = e.webviewPanel;
        const enteringActive = panel.active && !wasActive;
        wasActive = panel.active;
        if (panel.visible) {
          dispatch({ type: "viewStateVisible" });
        }
        if (enteringActive && lastKnownCaret !== null) {
          post(buildCaretApplyMessage(lastKnownCaret));
        }
      },
      undefined,
      disposables
    );

    // --- Dirty-doc on-disk conflict watcher ---------------------------------
    // The orchestration (debounce, single-flight, read → prompt → reload flow)
    // lives in the vscode-free createDirtyDocConflictWatcher factory; this
    // wires the VS Code touchpoints and hands the disposable to teardown.
    // file-scheme only: createFileSystemWatcher needs a real path, and a
    // non-file doc (untitled / virtual) has no backing disk to diverge from.
    if (document.uri.scheme === "file") {
      // Watch the parent directory with a plain `*` and filter by URI in the
      // factory, rather than globbing the basename directly: a filename with
      // glob metacharacters (e.g. `notes[1].md`, `a{b}.md`) would otherwise
      // miss or mis-match (Codex C88). `*` is non-recursive — direct children
      // only — so this stays scoped to the document's own folder.
      const watcher = workspace.createFileSystemWatcher(
        new RelativePattern(Uri.joinPath(document.uri, ".."), "*"),
        false, // ignoreCreate: an atomic save (temp + rename) can surface as create
        false, // ignoreChange: the common in-place external write
        true // ignoreDelete: a deleted backing file is the platform's UX, not a content conflict
      );
      disposables.push(watcher);

      const conflictWatcher = createDirtyDocConflictWatcher({
        // onDidChange + onDidCreate are the divergence signals; the factory
        // filters by URI and debounces. The teardown disposes both listeners.
        subscribe: (onSignal) => {
          const subs = [
            watcher.onDidChange((changed) => onSignal(changed.toString())),
            watcher.onDidCreate((changed) => onSignal(changed.toString())),
          ];
          return () => {
            for (const sub of subs) {
              sub.dispose();
            }
          };
        },
        documentUriString: document.uri.toString(),
        isDisposed: () => disposed,
        isDirty: () => document.isDirty,
        readDiskText: async () =>
          Buffer.from(await workspace.fs.readFile(document.uri)).toString("utf8"),
        readBufferText: () => canonicalDocumentText(document),
        promptReload: () =>
          this.harness?.diskConflictPromptOverride
            ? this.harness.diskConflictPromptOverride(
                DISK_CONFLICT_MESSAGE,
                DISK_CONFLICT_RELOAD,
                DISK_CONFLICT_KEEP
              )
            : window.showWarningMessage(
                DISK_CONFLICT_MESSAGE,
                DISK_CONFLICT_RELOAD,
                DISK_CONFLICT_KEEP
              ),
        reloadChoice: DISK_CONFLICT_RELOAD,
        // User-confirmed TRUE revert. reveal(...false) makes the panel the
        // active editor so the text-file revert targets THIS document; the
        // platform reload then fires onDidChangeTextDocument → the reducer
        // reseeds the webview with disk content (the same path the clean case
        // rides) AND clears the dirty flag + refreshes VS Code's etag.
        reloadFromDisk: async () => {
          webviewPanel.reveal(webviewPanel.viewColumn, false);
          await commands.executeCommand("workbench.action.files.revert");
        },
        showError,
      });
      disposables.push(conflictWatcher);
    }

    // Tier-0 reveal for the Claude Code handoff (deps.revealForMention — see
    // handle-context-handoff.ts's module header). Claude Code's zero-arg
    // `claude-code.insertAtMentioned` reads window.activeTextEditor (verified
    // against claude-code 2.1.199, re-verified through 2.1.204 — the 2.1.204
    // sibling `claude-vscode.insertAtMention` is the same zero-arg shape), and
    // activeTextEditor only ever points at a
    // VISIBLE text editor — so this document must be shown as a text editor
    // first. The showTextDocument options are pinned by empirical platform
    // facts, probed in a real VS Code host and asserted by
    // test/extension/e2e/reveal-for-mention-platform.test.ts:
    //   - preserveFocus:true NEVER sets activeTextEditor while a custom-editor
    //     tab is active (onDidChangeActiveTextEditor does not fire at all), so
    //     the upstream command silently no-ops — the live bug this replaced.
    //     preserveFocus:false sets activeTextEditor before showTextDocument
    //     even resolves. So the reveal MUST take focus: it moves to the temp
    //     editor for the flash duration and returns when the cleanup's tab
    //     close re-activates the Quoll custom tab.
    //   - ViewColumn.Active (the Quoll custom tab's own group) opens the text
    //     editor as a SECOND tab alongside the custom tab — it does not
    //     replace it — and closing that tab cleanly re-activates the custom
    //     tab with the document still open. In-place face-swap: no layout
    //     shift (the previous ViewColumn.Beside split shifted the layout twice
    //     — once opening, once closing).
    //   - Reuse an already-visible text editor of THIS doc when one exists (no
    //     duplicate tab, cleanup is then a no-op); else open in place
    //     (ViewColumn.Active, brief same-pane flash — the accepted product
    //     cost), preview:true so the temporary tab stays as light as VS Code
    //     allows.
    //   - Cleanup CONTRACT: after cleanup, the Quoll custom tab for this uri
    //     is the ACTIVE tab of its group again. Two phases (the pure planner
    //     lives in reveal-for-mention-cleanup.ts):
    //       (a) close the DELTA text tabs — tabs of this uri in groups that
    //           did NOT already hold one before the reveal (snapshot below),
    //           so the user's own pre-existing text tabs are never closed;
    //       (b) verify the contract and, ONLY when it failed, enforce it via
    //           vscode.openWith. The class phase (a) alone cannot cover: a
    //           background text tab of this doc already in the Quoll group is
    //           not in visibleTextEditors, so the reveal targets
    //           ViewColumn.Active and VS Code REUSES/activates that existing
    //           tab — no delta, nothing to close, and without (b) the pane
    //           stays switched to the raw text editor (the live ⌘⌥K bug
    //           pinned by e2e context-handoff-reveal-cleanup.test.ts).
    // Selection mapping (payload lines are 1-based, clamped + ordered by
    // handleContextHandoff before this is called, with no await in between —
    // lineAt cannot go out of range):
    //   - no selection → empty selection at (0,0) → Claude Code emits the
    //     whole-file `@rel` form.
    //   - selection → (start-1, 0) .. (end-1, endLineLength). The end
    //     character MUST be the end line's text length: Claude Code reads
    //     end.line regardless of character, but with a 0 end-char a
    //     single-line handoff (start === end) would collapse to an EMPTY
    //     selection and wrongly emit the whole-file form. Edge: a single-line
    //     handoff on an EMPTY line unavoidably degrades to the whole-file
    //     mention — accepted.
    const revealForMention = async (selection: {
      hasSelection: boolean;
      startLine: number;
      endLine: number;
    }): Promise<() => Thenable<void>> => {
      const uriString = document.uri.toString();
      const isThisDocTextTab = (tab: Tab): boolean =>
        tab.input instanceof TabInputText && tab.input.uri.toString() === uriString;
      const isThisDocCustomTab = (tab: Tab): boolean =>
        tab.input instanceof TabInputCustom &&
        tab.input.viewType === QuollEditorPanel.viewType &&
        tab.input.uri.toString() === uriString;
      // Live tab inventory in the pure planner's shape — see
      // reveal-for-mention-cleanup.ts. Re-taken at each decision point
      // (Tab object identity is not stable across tab-model events).
      const takeTabInventory = (): RevealCleanupGroup<Tab>[] =>
        window.tabGroups.all.map((group) => {
          const customTab = group.tabs.find(isThisDocCustomTab);
          return {
            viewColumn: group.viewColumn,
            // The active-group flag lets decideRevealInvariant reject a custom
            // tab that is active WITHIN its group while focus sits on another
            // group (a same-doc text editor revealed in a separate group).
            isActiveGroup: group.isActive,
            docTextTabs: group.tabs.filter(isThisDocTextTab),
            docCustomTab: customTab === undefined ? null : { isActive: customTab.isActive },
          };
        });
      // Snapshot the groups that already hold a text tab for this doc, keyed
      // by viewColumn (Tab object identity is not stable across tab-model
      // events), so the cleanup can tell a reveal-opened tab from a
      // pre-existing one.
      const groupsWithDocBefore = new Set<ViewColumn>();
      for (const group of window.tabGroups.all) {
        if (group.tabs.some(isThisDocTextTab)) {
          groupsWithDocBefore.add(group.viewColumn);
        }
      }
      const visibleColumn = window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uriString
      )?.viewColumn;
      const end = selection.hasSelection
        ? new Position(selection.endLine - 1, document.lineAt(selection.endLine - 1).text.length)
        : new Position(0, 0);
      const start = selection.hasSelection ? new Position(selection.startLine - 1, 0) : end;
      await window.showTextDocument(document, {
        viewColumn: visibleColumn ?? ViewColumn.Active,
        preserveFocus: false,
        preview: true,
        selection: new Selection(start, end),
      });
      return async () => {
        // Phase (a): close the DELTA text tabs (reveal-opened only). When the
        // reveal reused a pre-existing tab there is no delta — the user's own
        // tab is never closed.
        const toClose = planRevealTabClose(groupsWithDocBefore, takeTabInventory());
        if (toClose.length > 0) {
          await window.tabGroups.close(toClose, true);
          console.info("[quoll] context-handoff cleanup: closed reveal-opened text tab(s)", {
            count: toClose.length,
          });
        } else {
          console.info(
            "[quoll] context-handoff cleanup: no reveal-opened text tab to close (pre-existing tab reused or already gone)"
          );
        }
        // Phase (b): verify the cleanup contract — the Quoll custom tab for
        // this uri is the active tab of its group again — and enforce it only
        // when it provably failed. Enforcement is CONDITIONAL so the common
        // path (the delta close re-activates the custom tab) never runs
        // openWith and cannot fight Claude Code's own panel reveal for focus.
        // The tab model can lag tabGroups.close resolution, so poll briefly
        // before concluding failure (avoids spurious enforcement); a genuine
        // failure is corrected after the ~200 ms budget — imperceptible.
        let decision = decideRevealInvariant(takeTabInventory());
        for (let waited = 0; decision.kind === "enforce" && waited < 200; waited += 40) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          decision = decideRevealInvariant(takeTabInventory());
        }
        if (decision.kind === "enforce") {
          // supportsMultipleEditorsPerDocument:false → openWith re-reveals
          // the EXISTING custom editor (no second instance), and the user's
          // background text tab survives in place — both pinned by the
          // context-handoff-reveal-cleanup e2e.
          console.warn(
            "[quoll] context-handoff cleanup: custom tab not active after cleanup; enforcing via vscode.openWith",
            { viewColumn: decision.viewColumn }
          );
          await commands.executeCommand(
            "vscode.openWith",
            document.uri,
            QuollEditorPanel.viewType,
            decision.viewColumn
          );
        } else if (decision.kind === "no-custom-tab") {
          console.warn(
            "[quoll] context-handoff cleanup: no Quoll custom tab for this document; enforcement skipped"
          );
        }
      };
    };

    // Pre-command guard for the tier-0 delegation (see
    // HandleContextHandoffDeps.isDocumentActiveTextEditor): true when
    // window.activeTextEditor currently shows THIS document.
    const isDocumentActiveTextEditor = (): boolean =>
      window.activeTextEditor?.document.uri.toString() === document.uri.toString();

    const handleInbound = (raw: unknown): void => {
      if (disposed) {
        return;
      }
      if (!isWebviewToHost(raw)) {
        // Symmetric with the other silent-drop paths (write-lock inbound
        // Edit, write-lock ready) that log via console.warn. Inbound
        // validation failure is the most likely surface to hide a real
        // bug (protocol-bump mismatch, host/webview bundle divergence,
        // future external poster); without a log a "webview seems
        // frozen and nothing reaches the host" report has no signal to
        // distinguish validation failure from transport loss. Logging
        // only the type preview avoids leaking arbitrary payload to
        // the Output channel.
        const preview =
          typeof raw === "object" && raw !== null && "type" in (raw as Record<string, unknown>)
            ? (raw as Record<string, unknown>).type
            : typeof raw;
        console.warn("[quoll] dropping inbound webview message: failed validator", { preview });
        return;
      }
      switch (raw.type) {
        case "ready":
          dispatch({ type: "ready" });
          postEditorConfig();
          // Reverse switch caret restore. A REVERSE-created panel is fresh (no
          // pending edit, no write-lock), so the ready dispatch posts the seed
          // Document synchronously and this selection-only caret-apply lands
          // AFTER it (FIFO). (The write-lock path that can drop a ready-driven
          // Document only arises on an already-live panel's resync, never on a
          // just-constructed reverse-switch panel.) Pure side channel (no
          // reducer/write-lock). One-shot so a webview reload does not re-fire.
          if (switchCaret !== null && !switchCaretApplied) {
            switchCaretApplied = true;
            post(buildCaretApplyMessage(switchCaret));
          }
          return;
        case "edit":
          // Snapshot the live VS Code inputs the core needs to decide the
          // verdict (document.version for the source-of-truth resync,
          // canWriteNow() for the readonly gate, canonical text for the
          // no-op comparison) — the transition is then a pure function of
          // these. When the write lock is held the edit is STASHED (core
          // `edit` arm reads content/baseDocVersion only, never
          // currentContent), so skip the O(n) canonicalisation — the drain
          // re-snapshots at settlement. Mirrors the lazy `drainSnapshot`.
          dispatch({
            type: "edit",
            baseDocVersion: raw.baseDocVersion,
            content: raw.content,
            documentVersion: document.version,
            canWrite: canWriteNow(),
            currentContent: isWriteLockHeld(state) ? "" : canonicalDocumentText(document),
          });
          return;
        case "open-external":
          dispatch({ type: "openExternal", href: raw.href });
          return;
        case "open-link":
          // Phase-1 page-to-page navigation. Direct host-side side effect (no
          // document-state mutation → not a core reducer transition, like
          // open-external). The host owns document.uri; the webview sent only
          // the decoded relative destination string. handleOpenLink resolves it
          // against THIS document's directory, enforces workspace/doc-dir
          // containment, and opens the target with the Quoll editor via the
          // open-in-quoll adapter. No edit-settled barrier: it opens a DIFFERENT
          // document and reads only the stable document.uri (never the in-flight
          // content/dirty state). Dropped when disposed by the top-of-handleInbound
          // guard, like every other side channel.
          handleOpenLink(raw.href, {
            documentUri: document.uri,
            joinPath: (base, ...segments) => Uri.joinPath(base, ...segments),
            isInWorkspace: (uri) => workspace.getWorkspaceFolder(uri) !== undefined,
            openWith:
              this.harness?.openLinkOverride ??
              ((uri) => openInQuollEditor(uri, QuollEditorPanel.viewType)),
            showError,
          });
          return;
        case "image-write":
          runImageWrite(raw.requestId, raw.data);
          return;
        case "context-handoff": {
          // Direct host-side side effect (no document-state mutation → not a
          // core reducer transition, like image-write). The host owns the
          // path: build it from THIS document's uri, never from the webview.
          // Drop if the panel is already disposed; a handoff already in flight
          // is allowed to settle (panel-level side effect, as with image-write).
          if (disposed) {
            return;
          }
          // Edit-applied barrier: if a flushed edit is still applying (write
          // lock held), DEFER the handoff so its save/clamp/delegation read the
          // applied document, not the pre-edit snapshot. Runs immediately when
          // the lock is free (the common path). `raw` is a const binding to the
          // inbound message object — stable across the deferral window (the
          // object is not mutated and cannot be reassigned), so the deferred
          // reads of raw.hasSelection/startLine/endLine are safe.
          editSettledBarrier.run(() => {
            void handleContextHandoff(
              {
                hasSelection: raw.hasSelection,
                startLine: raw.startLine,
                endLine: raw.endLine,
              },
              {
                relativePath: workspace.asRelativePath(document.uri),
                getLineCount: () => document.lineCount,
                isDirty: document.isDirty,
                save: () => document.save(),
                writeClipboard: (text) => env.clipboard.writeText(text),
                executeCommand: (id) => commands.executeCommand(id),
                showInfo: (message) => window.showInformationMessage(message),
                showWarn: (message) => window.showWarningMessage(message),
                showError: (message) => window.showErrorMessage(message),
                // Tier-0 activeTextEditor choreography — hoisted closures above.
                revealForMention,
                isDocumentActiveTextEditor,
              }
            );
          });
          return;
        }
        case "codex-context-handoff": {
          // Codex (openai.chatgpt) whole-file handoff. A DISTINCT message type
          // (not a target field on context-handoff): Codex carries no selection
          // geometry (addFileToThread is whole-file only), the Claude arm above
          // stays byte-identical, and an unknown-type host fails closed. Direct
          // side effect (no document-state mutation), same posture as the
          // context-handoff arm. Drop if disposed; a handoff already in flight is
          // allowed to settle (panel-level side effect, as with image-write).
          if (disposed) {
            return;
          }
          if (codexHandoffInFlight) {
            return;
          }
          // Set the single-flight guard at RECEIPT so a rapid ⌘J repeat during
          // the barrier-deferral window is dropped (not queued twice). It is
          // released two ways, exactly one of which fires: the handler's
          // `.finally` when the thunk RUNS, or the barrier's `onDrop` when the
          // thunk is DROPPED (a failed-apply `settle(false)` or a dispose) and
          // never runs. Without the onDrop release, a failed-apply drop while
          // the panel stays ALIVE would strand the guard true and silence every
          // later Codex handoff.
          codexHandoffInFlight = true;
          // Edit-applied barrier: defer the whole-file add behind an in-flight
          // apply so Codex reads the APPLIED file (addFileToThread reads disk
          // after our save()), not the pre-edit snapshot.
          editSettledBarrier.run(
            () => {
              void handleCodexContextHandoff({
                documentUri: document.uri,
                isDirty: document.isDirty,
                save: () => document.save(),
                executeCommand: (id, arg) => commands.executeCommand(id, arg),
                showInfo: (message) => window.showInformationMessage(message),
                showWarn: (message) => window.showWarningMessage(message),
              }).finally(() => {
                codexHandoffInFlight = false;
              });
            },
            () => {
              codexHandoffInFlight = false;
            }
          );
          return;
        }
        case "lint-diagnostics":
          // Advisory lint mirror → Problems panel. Pure side channel: it does
          // NOT enter the host-session core (no write lock, no document
          // mutation), mirroring image-write / context-handoff. The wire
          // carries line/character ranges, so the conversion is
          // host-document-independent (no positionAt) — EOL-correct and
          // stale-safe. Severities are Warning/Information only; write-gate
          // errors stay on the separate edit-rejected/toast path. The outer
          // `if (disposed) return` at the top of handleInbound already guards
          // a dispose race. Gated by quoll.lint.problems.enabled via
          // LintMirror; in-editor underlines stay unconditional (webview side).
          this.lintMirror.mirror(document.uri, toLintDiagnostics(raw.diagnostics));
          return;
        case "caret-report":
          // Pure side channel: store the webview's latest caret for the
          // Quoll→text-editor handoff. Never enters the host-session core
          // (no write lock, no document mutation) — like lint-diagnostics /
          // context-handoff. The protocol validator already bounded the
          // coordinates; they are re-clamped at apply time.
          lastKnownCaret = { line: raw.line, character: raw.character };
          return;
        case "switch-to-text": {
          // Pure side channel: reopen THIS document in the built-in text editor.
          // Never enters the host-session core (no write lock, no document
          // mutation). The panel owns document.uri, so no path crosses the wire.
          //
          // Edit-applied barrier: if a flushed edit is still applying, DEFER the
          // switch so the reopened text editor shows the applied content (and
          // the caret handoff clamps against the applied document). Runs
          // immediately when the lock is free.
          //
          // Caret handoff: vscode.openWith disposes THIS panel as part of the
          // swap, unsubscribing the window.onDidChangeActiveTextEditor caret
          // listener BEFORE the text editor activates — so we cannot rely on it.
          // Capture lastKnownCaret at run time and apply it directly once
          // openWith resolves. applyCaretToTextEditor + document.uri are closure
          // locals, safe to call post-dispose (they touch a TextEditor, not the
          // webview).
          editSettledBarrier.run(() => {
            const caret = lastKnownCaret;
            void openInTextEditor(document.uri).then(
              () => {
                if (caret === null) {
                  return;
                }
                const editor = window.visibleTextEditors.find(
                  (e) => e.document.uri.toString() === document.uri.toString()
                );
                if (editor) {
                  applyCaretToTextEditor(editor, caret);
                }
              },
              (err: unknown) => {
                // Symmetric with quoll.toggleEditor's forward error toast (a
                // silent console-only failure would make the button look dead).
                console.error("[quoll] switch-to-text openWith rejected", err);
                void window
                  .showErrorMessage(
                    `Quoll: could not open the text editor: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  )
                  .then(undefined, (e: unknown) =>
                    console.error("[quoll] showErrorMessage rejected", e)
                  );
              }
            );
          });
          return;
        }
        default: {
          // Exhaustiveness guard — when a new WebviewToHost variant is
          // added without a case here, TS flags the assignment as
          // `never` at compile time. The isWebviewToHost boundary
          // validator already rejects unknown wire types, so this arm
          // is unreachable under the protocol; it documents the
          // closed-union invariant statically.
          const _exhaustive: never = raw;
          throw new Error(
            `[quoll] unhandled WebviewToHost: ${(_exhaustive as { type: string }).type}`
          );
        }
      }
    };

    webviewPanel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        this.harness?.recordInbound(raw);
        handleInbound(raw);
      },
      undefined,
      disposables
    );

    // Install panelControls on the harness AFTER message registration so a
    // test that races setActivePanel against the eager-seed Document still
    // sees activePanel non-null by the time the seed event is recorded.
    // The eager `dispatch({ type: "seed" })` at the end of
    // resolveCustomTextEditor fires AFTER this install — ordering invariant
    // pinned.
    let panelControls: PanelControls | null = null;
    if (this.harness) {
      panelControls = {
        document,
        webviewPanel,
        simulateInbound: handleInbound,
        // Mirror the real onDidReceiveMessage callback (record THEN
        // handle) so a test can drive a wire-malformed payload through
        // the validator and observe both arms — the inbound recorder
        // firing pre-validator and the validator drop (no Document
        // follows). `simulateInbound` cannot: it skips recordInbound
        // and its WebviewToHost param rejects a malformed payload at
        // compile time.
        rawSimulate: (raw: unknown) => {
          this.harness?.recordInbound(raw);
          handleInbound(raw);
        },
      };
      this.harness.setActivePanel(panelControls);
    }

    webviewPanel.onDidDispose(() => {
      // Snapshot the write lock BEFORE the disposed transition clears it — the
      // revert-rescue (below) must skip when a reducer applyEdit is in flight
      // (else it races that apply's landing with a stale span = wrong-offset
      // corruption). The `disposed` transition sets pendingApplyBaseVersion to
      // null, so this MUST be read before the dispatch below.
      const writeInFlightAtDispose = isWriteLockHeld(state);
      // Set the local guard FIRST (arms the executor / listener guards),
      // then drive the core's `disposed` transition (clears the write lock
      // so any late settlement is a no-op), then tear down.
      disposed = true;
      // Drop any pending coalesced documentChanged — the panel is gone; the
      // trailing dispatch would be a no-op anyway (the thunk's `disposed`
      // guard), but cancelling releases the timer + closure promptly.
      scheduleDocumentChanged.cancel();
      dispatch({ type: "disposed" });
      // Clear THIS document's lint diagnostics when its editor closes. The
      // collection itself outlives the panel (disposed via context.subscriptions
      // on extension deactivate); only this uri's entry is removed so a
      // re-open re-populates cleanly. Satisfies "diagnostics clear on close".
      this.lintMirror.remove(document.uri);
      if (panelControls) {
        this.harness?.setActivePanel(null, panelControls);
      }
      // VS Code's Disposable.from is a plain loop with no per-item
      // try/catch: a throwing dispose() aborts the rest, leaking the
      // remaining items. The outer try/catch at least surfaces the error.
      try {
        Disposable.from(...disposables).dispose();
      } catch (err) {
        console.error("[quoll] error during disposables teardown", err);
      } finally {
        disposables.length = 0;
      }
      // Revert-rescue (see the tracker construction above). If closing THIS
      // custom editor made VS Code revert the shared working copy while another
      // editor still holds the document, re-apply the dirty bytes so the still-
      // open editor does not silently lose them. Runs AFTER teardown: the edit
      // targets the TextDocument (not the disposed webview), and the surviving
      // editor keeps the document alive so applyEdit is not a no-op. The change
      // event this applyEdit fires cannot re-enter the tracker/reducer — both
      // subscriptions are disposed above and the `disposed` guard drops any late
      // callback.
      const uriString = document.uri.toString();
      const hasSurvivingEditor = window.tabGroups.all.some((group) =>
        group.tabs.some(
          (tab) =>
            (tab.input instanceof TabInputText && tab.input.uri.toString() === uriString) ||
            (tab.input instanceof TabInputTextDiff && tab.input.modified.toString() === uriString)
        )
      );
      const rescue = revertRescue.decideOnDispose({
        writeInFlight: writeInFlightAtDispose,
        hasSurvivingEditor,
        canWrite: canWriteNow(),
        currentContent: document.getText(),
        disposedAt: Date.now(),
      });
      if (rescue.rescue) {
        const span = minimalEditSpan(document.getText(), rescue.content);
        const edit = new WorkspaceEdit();
        edit.replace(
          document.uri,
          new Range(document.positionAt(span.from), document.positionAt(span.to)),
          span.insert
        );
        void workspace.applyEdit(edit).then(
          (ok) => {
            if (ok) {
              void window
                .showInformationMessage(
                  "Quoll kept your unsaved changes — they are still open in the text editor."
                )
                .then(undefined, (err: unknown) =>
                  console.error("[quoll] revert-rescue info toast rejected", err)
                );
            } else {
              // Data-loss context with no editor left to retry: surface it
              // (mirrors host-session-core's failed-save showError-survives-dispose).
              showError("Quoll could not restore your unsaved changes after closing the editor.");
            }
          },
          (err: unknown) => {
            showError(
              `Quoll could not restore your unsaved changes: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        );
      }
      if (QUOLL_PERF) {
        perfReport("host:session");
      }
    });

    // Eager seed: VS Code buffers webview.postMessage calls after
    // webview.html = ... until the webview script registers its
    // message listener. Buffering is internal-implementation behaviour
    // not formally documented in the VS Code API, but stable for years.
    // The Ready handshake (webview → 'ready' → host → postDocument) is
    // the reliable fallback path. If VS Code ever stops buffering, the
    // eager seed becomes a no-op and Ready takes over.
    dispatch({ type: "seed" });
    postEditorConfig();
  }

  static getWebviewContent(webview: Webview, extensionUri: Uri, document: TextDocument): string {
    const nonce = getNonce();
    const assetUris = buildWebviewAssetUris(webview, extensionUri);
    return buildWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      resourceBaseUri: buildResourceBaseUri(webview, document),
      ...assetUris,
    });
  }
}
