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
  Event,
  ExtensionContext,
  TextDocument,
  Webview,
  WebviewPanel,
} from "vscode";
import {
  ColorThemeKind,
  ConfigurationTarget,
  Disposable,
  env,
  languages,
  Range,
  StatusBarAlignment,
  TabInputText,
  TabInputTextDiff,
  Uri,
  WorkspaceEdit,
  window,
  workspace,
} from "vscode";

import { createIncrementalWriteValidator } from "../markdown/validate-for-write.js";
import { perfReport } from "../shared/perf.js";
import {
  buildFormatCommandMessage,
  type FormatCommandMessage,
  isWebviewToHost,
} from "../shared/protocol.js";
import { canHostWrite } from "./can-host-write.js";
import { createCaretHandoffWiring } from "./caret-handoff-wiring.js";
import { createContextHandoffWiring } from "./context-handoff-wiring.js";
import { createDiskConflictWiring } from "./disk-conflict-wiring.js";
import { buildDocumentMessageFromDocument, canonicalDocumentText } from "./document-canonical.js";
import {
  buildCaretApplyMessage,
  buildDocumentMessage,
  buildEditorConfigMessage,
  buildEditRejectedMessage,
  buildThemeMessage,
} from "./document-message.js";
import { createEditSettledBarrier } from "./edit-settled-barrier.js";
import { createEditorConfigWiring } from "./editor-config-wiring.js";
import { isRelevantConfigChange, readEditorPrefs } from "./editor-prefs-config.js";
import { takeSwitchCaret } from "./editor-switch-caret.js";
import { createEffectExecutor } from "./effect-executor.js";
import { clearActiveFormatPoster, setActiveFormatPoster } from "./format-command.js";
import { getNonce } from "./get-nonce.js";
import { handleOpenExternal } from "./handle-open-external.js";
import { handleOpenLink } from "./handle-open-link.js";
import { handleUpdateConfig } from "./handle-update-config.js";
import {
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEvent,
  isWriteLockHeld,
} from "./host-session-core.js";
import { createImageWriteWiring } from "./image-write-wiring.js";
import { toLintDiagnostics } from "./lint-diagnostics.js";
import { LintMirror } from "./lint-mirror.js";
import { openInQuollEditor } from "./open-in-quoll.js";
import { openInTextEditor } from "./reopen-text-editor.js";
import { createRevertRescueWiring } from "./revert-rescue-wiring.js";
import { showSafely } from "./show-safely.js";
import type { StatusBarSlots } from "./status-bar.js";
import { noteSurface } from "./surface-memory.js";
import { finalizeSurfaceSwap, findSourceTab } from "./surface-swap.js";
import type { PanelControls, TestHarness } from "./test-harness.js";
import { createThemeSyncWiring } from "./theme-sync-wiring.js";
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
const PROSE_LINT_CONFIG_KEY = "quoll.lint.prose.enabled";

function readProseLintEnabled(): boolean {
  return workspace.getConfiguration().get<boolean>(PROSE_LINT_CONFIG_KEY, false);
}

// `affectsConfiguration` matches on this exact key.
const SPELLCHECK_CONFIG_KEY = "quoll.editor.spellcheck";

function readSpellcheckEnabled(): boolean {
  return workspace.getConfiguration().get<boolean>(SPELLCHECK_CONFIG_KEY, true);
}

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

    // showError centralises window.showErrorMessage with rejection handling
    // (via showSafely). Hoisted above the try/catch below so the catch arm can
    // reuse it instead of inlining a call that would silently swallow toast
    // rejections — the same asymmetry showError closes for every other call
    // site below (grep `showError(` for the full set).
    const showError = (message: string): void => {
      this.harness?.recordError(message);
      showSafely(window.showErrorMessage(message), "showErrorMessage");
    };

    // Reverse editor-switch caret restore (one-shot). A text-editor→Quoll switch
    // (quoll.toggleEditor) stashed the caret under this uri just before creating
    // THIS panel; take it (clearing the store — consumed regardless of whether
    // construction below succeeds) and apply it once at `ready`, after the seed
    // Document. null when this panel was not opened via a switch.
    const switchCaret = takeSwitchCaret(document.uri.toString());

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

    // Register a VS Code Event listener that is skipped once the panel is disposed,
    // returning the Disposable so the caller controls teardown (a wiring factory's
    // `subscribe` closure wraps it as a teardown; a still-inline listener pushes it
    // to `disposables`). Closes over `disposed` once so the
    // `(e) => { if (disposed) return; … }` guard is written a single time.
    const subscribeWhileAlive = <T>(event: Event<T>, handler: (e: T) => void): Disposable =>
      event((e) => {
        if (disposed) {
          return;
        }
        handler(e);
      });

    // Status-bar parity (src/extension/status-bar.ts). A custom editor is not a
    // TextEditor, so window.activeTextEditor is undefined and VS Code drops ALL
    // of its built-in status-bar items. This host-owned surface reintroduces the
    // subset whose data already flows here — caret position, EOL, a static
    // language label — shown ONLY while THIS panel is active. Right-aligned with
    // descending priority so the order matches native (caret leftmost).
    // Under the E2E harness, build recording fakes so a test can observe
    // show/hide/dispose per panel — window.createStatusBarItem is otherwise
    // invisible to the harness. Production keeps the real items. The trio (when
    // present) is handed to panelControls below for per-panel observation. The
    // slots are handed to createCaretHandoffWiring below, which drives them
    // (this panel stays the single window.createStatusBarItem caller).
    const statusBarProbes = this.harness
      ? [
          this.harness.newStatusBarItem(StatusBarAlignment.Right, 102),
          this.harness.newStatusBarItem(StatusBarAlignment.Right, 101),
          this.harness.newStatusBarItem(StatusBarAlignment.Right, 100),
        ]
      : null;
    const statusBarSlots: StatusBarSlots = statusBarProbes
      ? { caret: statusBarProbes[0], eol: statusBarProbes[1], language: statusBarProbes[2] }
      : {
          caret: window.createStatusBarItem(StatusBarAlignment.Right, 102),
          eol: window.createStatusBarItem(StatusBarAlignment.Right, 101),
          language: window.createStatusBarItem(StatusBarAlignment.Right, 100),
        };

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

    // Forward inline-format actions from the global `quoll.format` command to
    // this webview when the panel is the active editor. Bound once so the
    // identity-guarded clear (below) matches on the active edge / dispose.
    const formatPoster = (action: FormatCommandMessage["action"]): void => {
      post(buildFormatCommandMessage(action));
    };
    // onDidChangeViewState does NOT fire for the initial active state, so
    // register once here if this panel opens active (the edge handler owns it
    // thereafter). This runs after `post`/`formatPoster` are defined.
    if (webviewPanel.active) {
      setActiveFormatPoster(formatPoster);
    }

    // Image-write executor. Orthogonal to the document-text write lock (it writes
    // a SEPARATE binary file, not the TextDocument), so it does NOT enter the
    // host-session core. The VS Code wiring (assets/ dir create + write, override
    // resolution, result post) lives in createImageWriteWiring; canWriteNow() is
    // the read-only guard (defense in depth: the webview also drops paste on
    // !canWrite). No shared mutable state with the reducer.
    const imageWriteWiring = createImageWriteWiring({
      documentUri: document.uri,
      canWrite: canWriteNow,
      showError,
      post,
      writeFileOverride: () => this.harness?.writeImageFileOverride ?? null,
    });

    // Status-bar + caret-handoff wiring (see caret-handoff-wiring.ts). Owns the
    // status-bar controller, the three per-panel caret locals, applyCaretToText-
    // Editor, the selection/active-editor caret trackers, and the active-edge
    // half of onDidChangeViewState. Pure side channel vs the reducer; the core
    // `viewStateVisible` resync dispatch is injected (dispatchViewStateVisible)
    // so the reducer dispatch stays here, and the webview `caret-apply` post is
    // injected (postCaretApply). Constructed AFTER `post`/`dispatch` exist. The
    // panel keeps building the status-bar SLOTS (harness-aware) so it stays the
    // single window.createStatusBarItem caller and can expose the probe trio on
    // panelControls. Disposed with the panel via the teardown loop below.
    const caretWiring = createCaretHandoffWiring({
      document,
      webviewPanel,
      statusBarSlots,
      switchCaret,
      isDisposed: () => disposed,
      postCaretApply: (caret) => post(buildCaretApplyMessage(caret)),
      dispatchViewStateVisible: () => dispatch({ type: "viewStateVisible" }),
    });
    disposables.push(caretWiring);

    // Revert-rescue wiring (see revert-rescue-wiring.ts + docs/LEARNING.md). VS
    // Code core reverts the shared working copy when THIS custom editor tab is
    // closed via "Don't Save" while a built-in text editor for the same resource
    // stays open. The provider has no hook to PREVENT that, so the factory REPAIRS
    // it on dispose (and the reverse text-tab-close direction while alive). It also
    // owns the lock-free external-edit `documentChanged` coalescing (the
    // onDidChangeTextDocument body). The panel injects the VS Code event sources as
    // subscribe closures (uri filter + TabInput* detection stay here) and the lazy
    // reducer/write reads; the factory owns the tracker + decision + restore edit.
    // Created HERE (the old onDidChangeTextDocument site) so the doc-change
    // subscription keeps its former disposables position. The tab-close
    // subscription (formerly registered later) now tears down at this earlier
    // slot — behaviourally inert: teardown is a side-effect-free unsubscribe and
    // both handlers are disposed-guarded no-ops once torn down.
    const uriString = document.uri.toString();
    const revertRescueWiring = createRevertRescueWiring({
      document,
      isDisposed: () => disposed,
      isWriteLockHeld: () => isWriteLockHeld(state),
      canWrite: canWriteNow,
      hasSurvivingEditor: () =>
        window.tabGroups.all.some((group) =>
          group.tabs.some(
            (tab) =>
              (tab.input instanceof TabInputText && tab.input.uri.toString() === uriString) ||
              (tab.input instanceof TabInputTextDiff && tab.input.modified.toString() === uriString)
          )
        ),
      dispatchDocumentChanged: (documentVersion) =>
        dispatch({ type: "documentChanged", documentVersion }),
      showError,
      subscribeDocumentChange: (onChange) => {
        const sub = subscribeWhileAlive(workspace.onDidChangeTextDocument, (e) => {
          if (e.document.uri.toString() !== uriString) {
            return;
          }
          onChange();
        });
        return () => sub.dispose();
      },
      subscribeTextTabClose: (onClose) => {
        const sub = subscribeWhileAlive(window.tabGroups.onDidChangeTabs, (e) => {
          const closedThisDoc = e.closed.some(
            (tab) =>
              (tab.input instanceof TabInputText && tab.input.uri.toString() === uriString) ||
              (tab.input instanceof TabInputTextDiff && tab.input.modified.toString() === uriString)
          );
          if (!closedThisDoc) {
            return;
          }
          onClose();
        });
        return () => sub.dispose();
      },
    });
    disposables.push(revertRescueWiring);

    // Theme sync: forwards a dark/light change as a `themeChanged` core event
    // (a core SIGNAL — it touches no document / write-lock / caret state). The
    // panel's `subscribe` closure maps ColorThemeKind → isDarkTheme (keeping the
    // factory vscode-free); the factory forwards that boolean to dispatch.
    const themeSync = createThemeSyncWiring({
      subscribe: (onThemeChange) => {
        const sub = subscribeWhileAlive(window.onDidChangeActiveColorTheme, (e) =>
          onThemeChange(e.kind === ColorThemeKind.Dark)
        );
        return () => sub.dispose();
      },
      onThemeChange: (isDarkTheme) => dispatch({ type: "themeChanged", isDarkTheme }),
    });
    disposables.push(themeSync);

    // Editor-surface config push (side channel, does NOT enter the host-session
    // core — the gutter/spellcheck flags are independent of document/edit
    // lifecycle). `push()` is called at seed + `ready` (so it lands regardless
    // of which handshake wins); the subscription re-pushes on a relevant
    // onDidChangeConfiguration. Idempotent webview-side. Created HERE (the old
    // config-listener site) so its disposables position — hence teardown order —
    // is unchanged.
    // Production config-get: resource-scoped to THIS document so a folder-level
    // override in a multi-root workspace is read + pushed for the right file.
    // NOTE: this deviates from the existing unscoped
    // readLintGutterEnabled/readSpellcheckEnabled reads — those are booleans with
    // no per-folder story yet; the preset reads are new and resource-correct from
    // the start. (A later PR can align the lint/spellcheck reads; out of scope here.)
    const getPref = (key: string, def: string): string =>
      workspace.getConfiguration(undefined, document.uri).get<string>(key, def);

    const editorConfig = createEditorConfigWiring({
      subscribe: (onRelevantChange) => {
        const sub = subscribeWhileAlive(workspace.onDidChangeConfiguration, (e) => {
          // The 4 preset keys are RESOURCE-SCOPED: pass document.uri so an
          // unrelated folder's change does NOT fire a redundant same-value push
          // into this webview (setEditorPrefs has no same-value guard, so a
          // redundant push = a real CM dispatch). lintGutter/spellcheck stay
          // unscoped, matching the existing boolean-read precedent. Extracted to
          // a pure predicate so the document.uri argument is unit-testable.
          if (
            isRelevantConfigChange(e, document.uri, [
              LINT_GUTTER_CONFIG_KEY,
              PROSE_LINT_CONFIG_KEY,
              SPELLCHECK_CONFIG_KEY,
            ])
          ) {
            onRelevantChange();
          }
        });
        return () => sub.dispose();
      },
      push: () =>
        post(
          buildEditorConfigMessage(
            readLintGutterEnabled(),
            readProseLintEnabled(),
            readSpellcheckEnabled(),
            readEditorPrefs(getPref)
          )
        ),
    });
    disposables.push(editorConfig);

    // Active-edge tracking for the `quoll.format` command's forward target.
    // PR6 (#179) moved the status-bar + caret-apply active edge into
    // createCaretHandoffWiring (above); this small listener owns ONLY the format
    // poster — set while this panel is the active editor, clear otherwise. Both
    // ops are idempotent (set overwrites the global; clear is identity-guarded),
    // so no inactive→active edge detection is needed. Kept separate from the
    // caret wiring so the inline-format feature stays single-responsibility.
    webviewPanel.onDidChangeViewState(
      (e) => {
        if (disposed) {
          return;
        }
        if (e.webviewPanel.active) {
          setActiveFormatPoster(formatPoster);
        } else {
          clearActiveFormatPoster(formatPoster);
        }
      },
      undefined,
      disposables
    );

    // --- Dirty-doc on-disk conflict watcher ---------------------------------
    // The VS Code wiring (file-scheme gate, parent-folder fs watcher, disk-read /
    // prompt / true-revert dep closures) lives in createDiskConflictWiring; the
    // pure orchestration stays in dirty-doc-conflict-watcher.ts. A non-file doc
    // gets an inert no-op wiring (nothing to diverge from). Disposed with the
    // panel (the wiring bundles both the fs watcher and the conflict watcher into
    // one dispose). All reads stay lazy (isDirty / buffer text / harness override
    // / viewColumn) so behaviour matches the former inline closures exactly.
    disposables.push(
      createDiskConflictWiring({
        documentUri: document.uri,
        isDisposed: () => disposed,
        isDirty: () => document.isDirty,
        readBufferText: () => canonicalDocumentText(document),
        promptOverride: () => this.harness?.diskConflictPromptOverride ?? null,
        revealPanel: () => webviewPanel.reveal(webviewPanel.viewColumn, false),
        showError,
      })
    );

    // Context-handoff wiring (Claude Code tier-0 delegation + Codex whole-file
    // add). Pure side channel — never enters the host-session core; it defers
    // both arms behind the editSettledBarrier so a handoff reads the APPLIED
    // document after an in-flight edit settles. The tier-0 reveal choreography,
    // the activeTextEditor guard, and the Codex single-flight guard all live in
    // createContextHandoffWiring. No shared mutable state with the reducer.
    const contextHandoffWiring = createContextHandoffWiring({
      document,
      viewType: QuollEditorPanel.viewType,
      editSettledBarrier,
      isDisposed: () => disposed,
    });

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
          // Guard-less: relies on handleInbound's top-of-function `disposed`
          // guard above, which already gates this whole switch.
          editorConfig.push();
          // Reverse switch caret restore (one-shot; see caret-handoff-wiring.ts).
          caretWiring.applySwitchCaretOnReady();
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
          imageWriteWiring.handle(raw.requestId, raw.data);
          return;
        case "context-handoff":
          contextHandoffWiring.handleContextHandoff({
            hasSelection: raw.hasSelection,
            startLine: raw.startLine,
            endLine: raw.endLine,
          });
          return;
        case "codex-context-handoff":
          contextHandoffWiring.handleCodexContextHandoff();
          return;
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
          // context-handoff. See caret-handoff-wiring.ts.
          caretWiring.reportCaret({
            line: raw.line,
            character: raw.character,
            selectedChars: raw.selectedChars,
          });
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
          // Forward in-place swap. openInTextEditor (vscode.openWith … "default")
          // opens the text editor as a SECOND tab beside THIS Quoll custom tab —
          // it does NOT replace it (E2E-probed 2026-07-10). We capture the
          // source custom tab now (before the barrier defers / the target
          // opens), apply the stashed caret to the freshly-opened text editor,
          // then finalizeSurfaceSwap saves-if-dirty and closes the Quoll tab so
          // only one surface remains. Closing disposes THIS panel, so it is the
          // last action; caret apply + document.uri are closure locals, safe
          // across the dispose. finalizeSurfaceSwap never throws and refuses to
          // close a doc it could not make clean (no revert / no data loss).
          const sourceTab = findSourceTab(
            document.uri.toString(),
            "quoll",
            QuollEditorPanel.viewType
          );
          editSettledBarrier.run(() => {
            const caret = caretWiring.getCaret();
            void openInTextEditor(document.uri).then(
              () => {
                // Record intent AFTER the open succeeds and BEFORE the source
                // close, so the surface-restore watcher adopts "text" for this
                // deliberate Quoll→text swap (a failed open records nothing).
                noteSurface(document.uri.toString(), "text");
                if (caret !== null) {
                  const editor = window.visibleTextEditors.find(
                    (e) => e.document.uri.toString() === document.uri.toString()
                  );
                  if (editor) {
                    caretWiring.applyCaretToTextEditor(editor, caret);
                  }
                }
                void finalizeSurfaceSwap(document.uri, sourceTab);
              },
              (err: unknown) => {
                // Symmetric with quoll.toggleEditor's forward error toast (a
                // silent console-only failure would make the button look dead).
                console.error("[quoll] switch-to-text openWith rejected", err);
                showSafely(
                  window.showErrorMessage(
                    `Quoll: could not open the text editor: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  ),
                  "showErrorMessage"
                );
              }
            );
          });
          return;
        }
        case "update-config":
          // Pure side channel: persist an editor-surface preset to GLOBAL config.
          // Never enters the host-session core (no write lock, no document
          // mutation) — like open-external / open-link. handleUpdateConfig
          // re-validates key+value, resets on a default id, and refuses to write
          // blind under a workspace override. onDidChangeConfiguration then
          // re-pushes editor-config to every open webview.
          handleUpdateConfig(raw.key, raw.value, {
            updateConfig: (key, value) =>
              workspace.getConfiguration().update(key, value, ConfigurationTarget.Global),
            inspectOverride: (key) => {
              // Resource-scoped inspect so a workspace-FOLDER override for THIS
              // document is seen (workspaceFolderValue is only populated when
              // the configuration is scoped to a resource uri).
              const info = workspace.getConfiguration(undefined, document.uri).inspect<string>(key);
              return {
                workspace: info?.workspaceValue !== undefined,
                folder: info?.workspaceFolderValue !== undefined,
              };
            },
            // Re-push the current editor-config so the popover's pending row
            // clears immediately in the override branch (no config write → no
            // onDidChangeConfiguration → this is the only signal that reaches it).
            repush: () => editorConfig.push(),
            showInfo: (message) =>
              showSafely(window.showInformationMessage(message), "showInformationMessage"),
            showError,
          });
          return;
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
        // Non-null in this branch: `this.harness` gates both the probe build
        // above and this panelControls install, so statusBarProbes is set.
        statusBarItems: statusBarProbes ?? [],
      };
      this.harness.setActivePanel(panelControls);
    }

    webviewPanel.onDidDispose(() => {
      // Snapshot the write lock + cancel the pending coalesced documentChanged
      // BEFORE the disposed transition clears the lock (prepareDispose reads
      // isWriteLockHeld(state) NOW). MUST run before dispatch({ type: "disposed" }).
      revertRescueWiring.prepareDispose();
      // Set the local guard FIRST (arms the executor / listener guards), then drive
      // the core's `disposed` transition (clears the write lock so any late
      // settlement is a no-op), then tear down.
      disposed = true;
      // Clear the format poster immediately so `quoll.format` can never forward
      // to a disposing panel. Primary guard; `post` (createEffectExecutor) is a
      // backstop that self-suppresses after dispose (effect-executor.ts).
      clearActiveFormatPoster(formatPoster);
      dispatch({ type: "disposed" });
      // Clear THIS document's lint diagnostics when its editor closes. The
      // collection itself outlives the panel (disposed via context.subscriptions on
      // extension deactivate); only this uri's entry is removed so a re-open
      // re-populates cleanly.
      this.lintMirror.remove(document.uri);
      if (panelControls) {
        this.harness?.setActivePanel(null, panelControls);
      }
      // VS Code's Disposable.from is a plain loop with no per-item try/catch: a
      // throwing dispose() aborts the rest, leaking the remaining items. The outer
      // try/catch at least surfaces the error. This tears down revertRescueWiring's
      // subscriptions too (pushed to disposables above).
      try {
        Disposable.from(...disposables).dispose();
      } catch (err) {
        console.error("[quoll] error during disposables teardown", err);
      } finally {
        disposables.length = 0;
      }
      // Revert-rescue AFTER teardown: the edit targets the TextDocument (not the
      // disposed webview), and the surviving editor keeps the document alive so
      // applyEdit is not a no-op. Uses the write-lock snapshot from prepareDispose.
      revertRescueWiring.rescueOnDispose();
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
    editorConfig.push();
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
