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
  Selection,
  TabInputCustom,
  TabInputText,
  Uri,
  ViewColumn,
  WorkspaceEdit,
  window,
  workspace,
} from "vscode";

import type { MarkdownError } from "../markdown/errors.js";
import { perfNow, perfRecord, perfReport } from "../shared/perf.js";
import type { HostToWebview } from "../shared/protocol.js";
import { isWebviewToHost } from "../shared/protocol.js";
import { canHostWrite } from "./canHostWrite.js";
import { type Caret, clampCaret } from "./caret-handoff.js";
import { buildDocumentMessageFromDocument, canonicalDocumentText } from "./document-canonical.js";
import {
  buildCaretApplyMessage,
  buildDocumentMessage,
  buildEditorConfigMessage,
  buildEditRejectedMessage,
  buildImageWriteResultMessage,
  buildThemeMessage,
} from "./document-message.js";
import { takeSwitchCaret } from "./editor-switch-caret.js";
import { getNonce } from "./getNonce.js";
import { handleCodexContextHandoff } from "./handle-codex-context-handoff.js";
import { handleContextHandoff } from "./handle-context-handoff.js";
import { handleOpenExternal } from "./handle-open-external.js";
import {
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEffect,
  type HostSessionEvent,
} from "./host-session-core.js";
import { handleImageWrite } from "./image-write-service.js";
import { toLintDiagnostics } from "./lint-diagnostics.js";
import { LintMirror } from "./lint-mirror.js";
import { minimalEditSpan } from "./minimal-edit.js";
import { openInTextEditor } from "./reopen-text-editor.js";
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
    let hostMountReported = false;

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
    // Active-edge tracker for the panel. onDidChangeViewState fires on
    // visible/active/focus changes; the caret apply must fire ONCE per
    // inactive→active transition, not on every event. Seeded from the panel's
    // current active state so the first event does not read a false edge.
    let wasActive = webviewPanel.active;

    // The pure host-session reducer owns every state mutation (write-lock
    // ordering, rejected-draft barrier, resync rules, settlement). This
    // file snapshots live VS Code inputs into EVENTS and runs the returned
    // EFFECTS; see host-session-core.ts for the transition table.
    const core = createHostSessionCore({
      uriString: document.uri.toString(),
      fsPath: document.uri.fsPath,
    });
    let state = core.initialState(document.version);

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
    };
    dispatch = createDrainingDispatcher<HostSessionEvent>(step);

    // canWriteNow gates host-side writes to on-disk file: documents only
    // (see src/extension/canHostWrite.ts). Re-checked at post time so
    // a runtime filesystem flip (read-only mount) is reflected on the
    // next Document push.
    const canWriteNow = (): boolean =>
      canHostWrite(document.uri.scheme, (scheme) => workspace.fs.isWritableFileSystem(scheme));

    // Host-side outbound. postMessage settles three ways:
    //   - resolves true  → VS Code runtime accepted/queued the message
    //                      (the only path that calls harness.recordEvent).
    //   - resolves false → runtime cannot route right now: disposed,
    //                      hidden with retainContextWhenHidden=false,
    //                      or mid-reload. Normal route, not an edge
    //                      case. Logged at console.warn so production
    //                      triage can spot delivery gaps; intentionally
    //                      NOT recorded as a delivered event.
    //   - rejects        → host/webview transport detached. Logged at
    //                      console.error; also NOT recorded.
    // The webview-side outbound handler does not expose an equivalent
    // delivery signal, so the host log is the only place this gap is
    // observable.
    const post = (message: HostToWebview): void => {
      if (disposed) {
        return;
      }
      // Route postMessage through the harness override when present so
      // tests can exercise the non-acceptance arms (ok=false / reject).
      // Production builds construct no harness, so
      // `harness?.webviewPostMessageOverride` is undefined and the real
      // webview surface is used directly.
      const send: (m: HostToWebview) => Thenable<boolean> =
        this.harness?.webviewPostMessageOverride ?? ((m) => webviewPanel.webview.postMessage(m));
      // A SYNCHRONOUS throw from send() escapes the `.then(...)` arms below:
      // the throw happens while EVALUATING `send(message)`, before the
      // Promise exists, so the reject arm never sees it. postMessage does not
      // throw synchronously in practice, but the harness seam / a future
      // transport could — and an unguarded throw here would unwind the
      // dispatch drain (and the VS Code event callback that drove this post).
      // Mirror runApplyEdit's sync-throw shape: catch + log, same triage
      // signal as the reject arm (Codex N5).
      let pending: Thenable<boolean>;
      const sendStart = QUOLL_PERF ? perfNow() : 0;
      try {
        pending = send(message);
      } catch (err) {
        console.error("[quoll] host→webview postMessage threw synchronously", err, {
          type: message.type,
        });
        return;
      }
      if (QUOLL_PERF) {
        perfRecord("host:postMessage", perfNow() - sendStart);
      }
      void pending.then(
        (ok) => {
          if (ok) {
            if (disposed) {
              return;
            }
            this.harness?.recordEvent(message);
            return;
          }
          console.warn("[quoll] host→webview postMessage resolved false", {
            type: message.type,
          });
        },
        (err: unknown) => {
          console.error("[quoll] host→webview postMessage rejected", err);
        }
      );
    };

    // Editor-surface config push (side channel, NOT through the host-session
    // core — the gutter flag is independent of document/edit lifecycle). Sent
    // at seed + ready (so it lands regardless of which handshake wins) and on
    // every relevant onDidChangeConfiguration. Idempotent: a duplicate is a
    // harmless no-op compartment reconfigure webview-side.
    const postEditorConfig = (): void => {
      post(buildEditorConfigMessage(readLintGutterEnabled()));
    };

    // Effect executor — turns each core EFFECT into the real side effect.
    // `postDocument` / `postRejectedDraft` stamp the wire docVersion from the
    // EFFECT (self-contained: the version a Document carries is a core
    // decision) and read only the live document text / theme / FS-writability
    // (those are not core state).
    const runEffects = (effects: readonly HostSessionEffect[]): void => {
      for (const effect of effects) {
        switch (effect.type) {
          case "postDocument": {
            const buildStart = QUOLL_PERF ? perfNow() : 0;
            const documentMessage = buildDocumentMessageFromDocument(document, {
              docVersion: effect.docVersion,
              isDarkTheme: window.activeColorTheme.kind === ColorThemeKind.Dark,
              canWrite: canWriteNow(),
            });
            if (QUOLL_PERF) {
              perfRecord("host:doc-build", perfNow() - buildStart);
            }
            post(documentMessage);
            // First postDocument is the seed; report once it (and its
            // host:postMessage) is recorded so host:mount carries both stages.
            if (QUOLL_PERF && !hostMountReported) {
              hostMountReported = true;
              perfReport("host:mount");
            }
            break;
          }
          case "postRejectedDraft":
            // docVersion is the core-managed value (NOT a fresh
            // document.version read) — the rejected draft never ran
            // applyEdit, so the version is unchanged and the webview's next
            // Edit keeps a matching base. ORDER IS LOAD-BEARING: the webview
            // reducer's `document` arm clears `serializeError`, so the
            // Document MUST precede the `edit-rejected` (reversing it would
            // wipe the banner the user needs).
            post(
              buildDocumentMessage({
                content: effect.content,
                docVersion: effect.docVersion,
                isDarkTheme: window.activeColorTheme.kind === ColorThemeKind.Dark,
                canWrite: canWriteNow(),
              })
            );
            // The replay banner is FAILURE-AWARE: route it through
            // `sendEditRejected` (with the core-stamped fresh delivery id),
            // NOT a bare `post`. A `ready`/`seed` replay can fail to deliver
            // (the webview detaches mid-reload — a documented-normal `post`
            // outcome); a bare post would drop that failure silently and the
            // rejection would stay stuck pending forever (the re-stamp already
            // invalidated the pre-replay `postEditRejected` failure that used
            // to recover it, and visible-edge resync is suppressed while a
            // rejection is pending). Routing through `sendEditRejected`
            // dispatches `editRejectedDeliveryFailed(id)` on failure, so the
            // core clears the rejection and reseeds a Document — recovery
            // instead of a deadlock (Codex N6).
            sendEditRejected(effect.error, effect.id);
            break;
          case "postEditRejected":
            sendEditRejected(effect.error, effect.id);
            break;
          case "postTheme":
            post(buildThemeMessage(effect.isDarkTheme));
            break;
          case "applyEdit":
            runApplyEdit(effect.content);
            break;
          case "showError":
            showError(effect.message);
            break;
          case "logWarn":
            console.warn(effect.message, effect.detail);
            break;
          case "openExternal":
            // No additional logging here — isAllowedUrl rejection +
            // openExternal reject / sync-throw are all logged inside
            // handleOpenExternal.
            //
            // `openExternalOverride` (when set) bypasses Uri.parse so the
            // open-external E2E test can pin the delegation contract without
            // depending on the real `env` binding — the test process cannot
            // spy on `env.openExternal` through the vscode module namespace.
            // The override sees the gated href as a plain string; same
            // surface as the production closure.
            handleOpenExternal(effect.href, {
              openExternal:
                this.harness?.openExternalOverride ?? ((url) => env.openExternal(Uri.parse(url))),
            });
            break;
          default: {
            // Exhaustiveness guard — a new HostSessionEffect variant without
            // a case here is flagged as `never` at compile time.
            const _exhaustive: never = effect;
            throw new Error(
              `[quoll] unhandled HostSessionEffect: ${(_exhaustive as { type: string }).type}`
            );
          }
        }
      }
    };

    // Edit-rejected delivery with a resync fallback re-entering the core,
    // carrying the per-delivery `id` (Codex N2/N6). If the webview refuses,
    // detaches, or `send()` throws, dispatching `editRejectedDeliveryFailed(id)`
    // clears the rejection and reseeds a normal Document so the panel does not
    // deadlock — but ONLY when that `id` still matches the pending rejection.
    // A stale failure (a newer rejection B is pending, the rejection was already
    // cleared by a resync/settlement, or a `ready`/`seed` replay re-stamped the
    // id) is a no-op in the `editRejectedDeliveryFailed` arm, so it can neither
    // clobber the live banner nor force an unsolicited reseed. When the clear
    // DOES fire, the user's typed content is overwritten — same "external wins"
    // semantics as for an `onDidChangeTextDocument` race.
    const sendEditRejected = (error: MarkdownError, id: number): void => {
      if (disposed) {
        return;
      }
      const message = buildEditRejectedMessage(error);
      const send: (m: HostToWebview) => Thenable<boolean> =
        this.harness?.webviewPostMessageOverride ?? ((m) => webviewPanel.webview.postMessage(m));
      // A SYNCHRONOUS throw from send() escapes the `.then(...)` arms below
      // (it happens before `Promise.resolve(...)` can assimilate it), so the
      // resync fallback would never run and the rejection would stay stuck
      // pending — the webview keeps a banner it can never resolve. Treat it
      // exactly like the reject arm: log + dispatch `editRejectedDeliveryFailed`
      // so the core clears the rejection and reseeds a Document (Codex N5).
      let pending: Thenable<boolean>;
      try {
        pending = send(message);
      } catch (err) {
        console.error("[quoll] edit-rejected delivery threw synchronously; resync fallback", err);
        dispatch({ type: "editRejectedDeliveryFailed", id });
        return;
      }
      // Promise.resolve(...) assimilation: a non-standard Thenable can no
      // longer resolve SYNCHRONOUSLY and re-enter the active drain — the
      // `editRejectedDeliveryFailed` feedback always lands in a fresh drain,
      // so it can never be stranded behind a throwing `.then` mid-drain.
      void Promise.resolve(pending).then(
        (ok) => {
          if (disposed) {
            return;
          }
          if (ok) {
            this.harness?.recordEvent(message);
            return;
          }
          console.warn("[quoll] edit-rejected delivery refused; resync fallback", {
            uri: document.uri.toString(),
            docVersion: state.lastAppliedDocVersion,
          });
          dispatch({ type: "editRejectedDeliveryFailed", id });
        },
        (err: unknown) => {
          if (disposed) {
            return;
          }
          console.error("[quoll] edit-rejected delivery rejected; resync fallback", err);
          dispatch({ type: "editRejectedDeliveryFailed", id });
        }
      );
    };

    // applyEdit executor — the lock is already set by the `accept`
    // transition; this only constructs the WorkspaceEdit, applies it, and
    // reports every outcome back via `applyEditSettled`. The construct /
    // apply SYNC-throw paths dispatch-then-`return` cleanly (the enqueued
    // outcome is drained by the same loop, clearing the optimistic lock);
    // the async settlement is funnelled through `Promise.resolve(...).then`
    // so it lands in a fresh drain.
    const runApplyEdit = (content: string): void => {
      // OLD text = the live buffer (applyEdit has not run yet, and the write
      // lock — set by the accept transition — blocks any other inbound edit on
      // the synchronous dispatch chain). Diff against the inbound NEW content to
      // the smallest single span. Resulting buffer is byte-identical to a
      // whole-document replace (measured ~90ms@1MB whole-doc vs flat ~0.5ms
      // minimal; see PERF.md § Write-path applyEdit baseline).
      const oldText = document.getText();
      // Snapshot the drain inputs the core needs at settlement. currentContent is
      // only consulted when a stash is waiting, so skip the O(n) canonicalisation
      // otherwise (Codex #6). Reads the closure `state`, as sendEditRejected
      // already does.
      const drainSnapshot = () => ({
        canWrite: canWriteNow(),
        currentContent: state.pendingEdit !== null ? canonicalDocumentText(document) : "",
      });
      const span = minimalEditSpan(oldText, content);
      if (span.from === span.to && span.insert.length === 0) {
        // No-op short-circuit (defensive — the core already gates no-ops via the
        // canonical currentContent compare; only a mixed-EOL literal-buffer
        // match could reach here). Settle ok with the UNCHANGED version so the
        // write lock releases + resync proceeds, WITHOUT submitting an empty
        // WorkspaceEdit.
        dispatch({
          type: "applyEditSettled",
          outcome: { kind: "ok", documentVersion: document.version },
          ...drainSnapshot(),
        });
        return;
      }
      let edit: WorkspaceEdit;
      try {
        // positionAt clamps out-of-range offsets (never throws) and
        // minimalEditSpan is pure — so constructThrew stays unreachable in
        // practice; the arm is preserved for parity with the prior path.
        edit = new WorkspaceEdit();
        edit.replace(
          document.uri,
          new Range(document.positionAt(span.from), document.positionAt(span.to)),
          span.insert
        );
      } catch (err) {
        dispatch({
          type: "applyEditSettled",
          outcome: {
            kind: "constructThrew",
            message: err instanceof Error ? err.message : String(err),
          },
          ...drainSnapshot(),
        });
        return;
      }
      let pending: Thenable<boolean>;
      const applyStart = QUOLL_PERF ? perfNow() : 0;
      try {
        pending = this.harness?.applyEditOverride
          ? this.harness.applyEditOverride(edit)
          : workspace.applyEdit(edit);
      } catch (err) {
        // Synchronous apply throw: immediate failure, not a latency sample —
        // intentionally not recorded under host:applyEdit.
        dispatch({
          type: "applyEditSettled",
          outcome: {
            kind: "applyThrew",
            message: err instanceof Error ? err.message : String(err),
          },
          ...drainSnapshot(),
        });
        return;
      }
      Promise.resolve(pending).then(
        (ok) => {
          if (QUOLL_PERF) {
            perfRecord("host:applyEdit", perfNow() - applyStart);
          }
          // Dispatch EVEN post-dispose: a stashed pending edit (typed
          // one-more-char then closed within the same ms while this apply held
          // the lock) can only drain on settlement, which fires AFTER
          // onDidDispose. The core stays a strict no-op post-dispose unless a
          // stash is waiting (host-session-core applyEditSettled). Webview-bound
          // posts self-suppress via post()'s disposed guard.
          dispatch({
            type: "applyEditSettled",
            outcome: ok ? { kind: "ok", documentVersion: document.version } : { kind: "refused" },
            ...drainSnapshot(),
          });
        },
        (err: unknown) => {
          if (QUOLL_PERF) {
            perfRecord("host:applyEdit", perfNow() - applyStart);
          }
          dispatch({
            type: "applyEditSettled",
            outcome: {
              kind: "rejected",
              message: err instanceof Error ? err.message : String(err),
            },
            ...drainSnapshot(),
          });
        }
      );
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

    workspace.onDidChangeTextDocument(
      (e) => {
        if (disposed) {
          return;
        }
        if (e.document.uri.toString() !== document.uri.toString()) {
          return;
        }
        dispatch({ type: "documentChanged", documentVersion: e.document.version });
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
        if (e.affectsConfiguration(LINT_GUTTER_CONFIG_KEY)) {
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

    // Tier-0 reveal for the Claude Code handoff (deps.revealForMention — see
    // handle-context-handoff.ts's module header). Claude Code's zero-arg
    // `claude-code.insertAtMentioned` reads window.activeTextEditor (verified
    // against claude-code 2.1.199), and activeTextEditor only ever points at a
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
          // these.
          dispatch({
            type: "edit",
            baseDocVersion: raw.baseDocVersion,
            content: raw.content,
            documentVersion: document.version,
            canWrite: canWriteNow(),
            currentContent: canonicalDocumentText(document),
          });
          return;
        case "open-external":
          dispatch({ type: "openExternal", href: raw.href });
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
          codexHandoffInFlight = true;
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
          // Caret handoff: vscode.openWith disposes THIS panel as part of the
          // swap, unsubscribing the window.onDidChangeActiveTextEditor caret
          // listener BEFORE the text editor activates — so we cannot rely on it.
          // Capture lastKnownCaret now and apply it directly once openWith
          // resolves. applyCaretToTextEditor + document.uri are closure locals,
          // safe to call post-dispose (they touch a TextEditor, not the webview).
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
      // Set the local guard FIRST (arms the executor / listener guards),
      // then drive the core's `disposed` transition (clears the write lock
      // so any late settlement is a no-op), then tear down.
      disposed = true;
      dispatch({ type: "disposed" });
      // Clear THIS document's lint diagnostics when its editor closes. The
      // collection itself outlives the panel (disposed via context.subscriptions
      // on extension deactivate); only this uri's entry is removed so a
      // re-open re-populates cleanly. Satisfies "diagnostics clear on close".
      this.lintMirror.remove(document.uri);
      if (panelControls) {
        this.harness?.setActivePanel(null, panelControls);
      }
      // Disposable.from continues even if one dispose() throws. A
      // hand-rolled while-pop bails on the first throw, leaking the
      // remaining listeners silently.
      try {
        Disposable.from(...disposables).dispose();
      } catch (err) {
        console.error("[quoll] error during disposables teardown", err);
      } finally {
        disposables.length = 0;
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
