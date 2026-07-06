// Vanilla CodeMirror mount.
//
// The drain (onReducerCommit) is the SOLE entry point that fires
// edit-sync's replayIfNeeded — the shell calls it synchronously from its
// dispatch wrapper after every state-changing transition. This is what
// guarantees no missed trigger; `replayIfNeeded`'s in-flight / consent
// guards inside edit-sync.ts handle re-entry.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { perfNow, perfRecord } from "../shared/perf.js";
import {
  type LintDiagnosticWire,
  MAX_CONTENT_LENGTH,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../shared/protocol.js";
import { applyCaret, type Caret, selectionToCaret } from "./cm/caret.js";
import { quollContextHandoffKeymap } from "./cm/context-handoff.js";
import { blockStyle } from "./cm/decorations/block-style.js";
import { blockZoneArrowKeymap } from "./cm/decorations/block-zone-arrow-keymap.js";
import { calloutMarkerConcealField } from "./cm/decorations/callout-marker-conceal.js";
import { fencedCodeCollapseField } from "./cm/decorations/fenced-code-collapse.js";
import { fencedCodeCopyButton } from "./cm/decorations/fenced-code-copy-button.js";
import { fencedCodeEnterKeymap } from "./cm/decorations/fenced-code-enter-keymap.js";
import { headingRhythm } from "./cm/decorations/heading-rhythm.js";
import { quollSyntaxReveal } from "./cm/decorations/index.js";
import { listHangIndent } from "./cm/list/list-hang-indent.js";
import { listIndentKeymap } from "./cm/list/list-indent-keymap.js";
import { proseSpaceMetric } from "./cm/decorations/prose-space-metric.js";
import { createEditSync } from "./cm/edit-sync.js";
import { quollFloatingToolbarScroll } from "./cm/floating-toolbar-scroll.js";
import { quollFolding } from "./cm/fold/index.js";
import {
  frontmatterBlockField,
  frontmatterRevealKeymap,
  hostDocumentReseed,
} from "./cm/frontmatter/index.js";
import { createImagePasteDrop, imageBlockField, quollResourceBaseUri } from "./cm/image/index.js";
import { quollLinkClickHandler } from "./cm/link-handlers.js";
import { quollLintFixKeymap } from "./cm/lint/apply-fix.js";
import { quollLintGutter } from "./cm/lint/gutter.js";
import { quollLint } from "./cm/lint/index.js";
import { quollMarkdownLanguage } from "./cm/markdown.js";
import { quollOutline } from "./cm/outline/index.js";
import { detectLineSeparator, splitToCmText } from "./cm/seed.js";
import { quollSwitchEditor } from "./cm/switch-editor.js";
import { tableBlockField, tableSkeletonField } from "./cm/table/index.js";
import {
  quollBlockStyleTheme,
  quollBulletMarkerTheme,
  quollCollapseToggleTheme,
  quollCopyButtonTheme,
  quollHeadingRhythmTheme,
  quollHighlighting,
  quollTaskCompletedContentTheme,
  quollTheme,
} from "./cm/theme.js";
import { getHost } from "./host.js";
import { type Action, canPostEdit, type WebviewState } from "./state.js";

type Dispatch = (action: Action) => void;

export type EditorOptions = {
  parent: HTMLElement;
  nonce: string;
  /** Fresh-read of the shell's reducer state. */
  getState: () => WebviewState;
  /** Stable dispatch closure from the shell. */
  dispatch: Dispatch;
  /** Webview-resource base URI for resolving relative image paths (from the
   *  host's data-resource-base-uri). "" for non-file documents. */
  resourceBaseUri?: string;
};

export type EditorHandle = {
  /** Replace the editor's document from a host snapshot. */
  applyDocument(rawText: string, canWrite: boolean, baseDocVersion: number): void;
  /** Fired by the shell after every state-changing dispatch — the SOLE
   *  drain entry point. */
  onReducerCommit(editInFlight: boolean): void;
  /** Teardown flush: push any pending (typed-but-undebounced) content to the
   *  host immediately. Wired by the shell to visibilitychange:hidden / pagehide
   *  / blur so a close cannot silently drop the last keystrokes. Single-flight-
   *  safe (delegates to edit-sync's flush → trySend). */
  flushPendingEdit(): void;
  /** Teardown: cancel any pending flush, destroy the EditorView, remove
   *  the mount node. */
  dispose(): void;
  /** Host replied to an image-write request. On success (relativePath non-null)
   *  and a still-pending requestId on a writable doc, insert `![](relativePath)`
   *  as a standalone block at the mapped anchor through the normal edit pipeline. */
  resolveImageWrite(requestId: string, relativePath: string | null): void;
  /** Toggle the opt-in advisory-lint gutter. Reconfigures a Compartment so the
   *  gutter extension is wholly present (on) or absent (off); off restores the
   *  pixel-identical no-gutter layout. Driven by the host's editor-config push. */
  setLintGutter(enabled: boolean): void;
  /** Apply a host-pushed caret (one-shot editor-switch handoff). Focuses the
   *  view — only when this webview already owns focus — so CodeMirror paints the
   *  cursor, then dispatches a selection-only transaction (no document mutation)
   *  clamped to the live doc, suppressing the echo caret-report. The dispatch is
   *  skipped when the caret is already at the target; the focus is not. */
  applyRemoteCaret(caret: Caret): void;
};

/** Dispatch `post-edit` and ship the Edit message in the same tick.
 *  Returns `true` if the host accepted the message (postMessage did not
 *  throw), `false` otherwise — edit-sync consumes the boolean to decide
 *  whether to retain the buffer. */
function postEditMessage(dispatch: Dispatch, content: string, baseDocVersion: number): boolean {
  if (content.length > MAX_CONTENT_LENGTH) {
    // The host boundary validator (isBoundedContent, shared/protocol.ts) drops
    // an over-limit `edit` with only a console.warn — no `edit-rejected`, no
    // ack Document. Without this pre-check editInFlight would latch forever,
    // every later keystroke's replay would be suppressed, and the user would
    // get NO signal that nothing is reaching disk. Route to the serialize-error
    // banner (the same surface the host reject path uses) and return false —
    // edit-sync's callers keep the buffer and never latch editInFlight. Each
    // subsequent keystroke clears the gate (local-edit-attempt) and re-attempts
    // the post, which lands back here and re-arms the banner while the doc stays
    // over-limit, so no oversized edit ever reaches the host.
    dispatch({
      type: "serialize-error",
      error: {
        code: "internal_error",
        message: `document is too large to save (over ${MAX_CONTENT_LENGTH.toLocaleString()} characters)`,
      },
    });
    return false;
  }
  dispatch({ type: "post-edit" });
  const message: WebviewToHost = {
    protocol: PROTOCOL_VERSION,
    type: "edit",
    content,
    baseDocVersion,
  };
  const postStart = QUOLL_PERF ? perfNow() : 0;
  try {
    getHost().postMessage(message);
    if (QUOLL_PERF) {
      perfRecord("webview:postMessage", perfNow() - postStart);
    }
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[quoll] postMessage(edit) failed", err);
    dispatch({
      type: "serialize-error",
      error: { code: "internal_error", message: `Could not send edit to host: ${detail}` },
    });
    return false;
  }
}

export function mountEditor(opts: EditorOptions): EditorHandle {
  const mount = document.createElement("div");
  const initialCanWrite = opts.getState().canWrite;
  mount.className = `quoll-editor${initialCanWrite ? "" : " read-only"}`;
  opts.parent.appendChild(mount);

  const editableComp = new Compartment();
  const lineSepComp = new Compartment();
  const lintGutterCompartment = new Compartment();
  const lintGutterExtension = quollLintGutter();
  let seeding = false;
  // Echo-suppression for the editor-switch caret handoff. Set true around the
  // selection-only dispatch in applyRemoteCaret so the updateListener below
  // does NOT bounce the just-applied caret straight back as a caret-report.
  // Same shape as `seeding` (a closure-local boolean, cleared in a finally).
  // The round-trip is doc-neutral and same-value, so this only trims traffic.
  let applyingRemoteCaret = false;
  // Mirrors the compartment's default-off state so a redundant `false` push
  // (the eager-seed + ready double-send, or an unrelated config change) is a
  // no-op instead of a churn-inducing reconfigure.
  let lintGutterEnabled = false;

  // edit-sync owns single-flight + debounce + buffer/replay. canPost is
  // the shared save-policy gate (canPostEdit, state.ts) — the SAME
  // predicate the reducer's post-edit case consults, so the gate cannot
  // drift between the two. Capability + in-flight stay edit-sync's own
  // concern (see the canPostEdit contract). getState is the shell's stable
  // closure → no stale read.
  const sync = createEditSync({
    getDoc: () => view.state.sliceDoc(),
    canPost: () => canPostEdit(opts.getState()),
    post: (content, baseDocVersion) => postEditMessage(opts.dispatch, content, baseDocVersion),
  });

  const imagePaste = createImagePasteDrop({
    canWrite: () => opts.getState().canWrite,
    post: (message) => getHost().postMessage(message),
  });

  // Mirror the editor's advisory lint set to the host so it appears in the
  // Problems panel. Display-only side channel: it never blocks a write and
  // carries no document mutation (the host publishes it into a Diagnostic
  // collection and never feeds it through the write-lock pipeline). Failures
  // are logged and swallowed — a dropped mirror is cosmetic and the next
  // debounced compute re-posts, so there is no user-visible data risk.
  const postLintDiagnostics = (diagnostics: readonly LintDiagnosticWire[]): void => {
    const message: WebviewToHost = {
      protocol: PROTOCOL_VERSION,
      type: "lint-diagnostics",
      diagnostics,
    };
    try {
      getHost().postMessage(message);
    } catch (err) {
      console.error("[quoll] postMessage(lint-diagnostics) failed", err);
    }
  };

  // Report the current caret to the host on every selection change (one-shot
  // side channel; the host keeps only the latest for the Quoll→text-editor
  // handoff). Failures are logged and swallowed — a dropped report just means
  // the host carries a slightly older caret on the next switch, never data loss.
  const postCaretReport = (caret: Caret): void => {
    const message: WebviewToHost = {
      protocol: PROTOCOL_VERSION,
      type: "caret-report",
      line: caret.line,
      character: caret.character,
    };
    try {
      getHost().postMessage(message);
    } catch (err) {
      console.error("[quoll] postMessage(caret-report) failed", err);
    }
  };

  const viewCreateStart = QUOLL_PERF ? perfNow() : 0;
  const view: EditorView = new EditorView({
    parent: mount,
    state: EditorState.create({
      doc: "",
      extensions: [
        EditorView.cspNonce.of(opts.nonce),
        // Multi-cursor reveal contract (Claude reviewer H1): CodeMirror
        // collapses multi-range selections to the main range unless this
        // facet is on, so every per-caret reveal in the decoration
        // providers would be unreachable for real multi-cursor users
        // without it. The orchestrator regression test enables the facet
        // explicitly; production needs the SAME contract.
        EditorState.allowMultipleSelections.of(true),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        quollMarkdownLanguage(),
        quollTheme,
        quollHighlighting,
        // Fenced-code panel + blockquote rule styling (block-style.ts line
        // decorations). An EditorView.theme (NOT styles.css) so it overrides
        // CM baseTheme's unlayered `.cm-line` padding — see cm/theme.ts.
        quollBlockStyleTheme,
        // Bullet-list marker dot styling (bullet-marker-reveal.ts marks). An
        // EditorView.theme like quollBlockStyleTheme so it beats CM's unlayered
        // baseTheme / syntax-highlight rules on the marked glyph span — see cm/theme.ts.
        quollBulletMarkerTheme,
        // Heading vertical rhythm styling (heading-rhythm.ts line decorations). An
        // EditorView.theme like quollBulletMarkerTheme so the two-class
        // `.cm-line.quoll-heading-rhythm-*` selector beats CM's unlayered baseTheme
        // `.cm-line` padding — see cm/theme.ts.
        quollHeadingRhythmTheme,
        // Completed-task content mute (task-checkbox-reveal.ts mark). An
        // EditorView.theme like quollBulletMarkerTheme so it is pinnable as an
        // exported spec; it overrides the inherited content foreground on the
        // marked span (coloured syntax tokens keep their colour) — see cm/theme.ts.
        quollTaskCompletedContentTheme,
        // Copy-code button overlay styling (position anchor + button look). An
        // EditorView.theme like quollBlockStyleTheme so it overrides CM's
        // unlayered `.cm-line` rules — see cm/theme.ts.
        quollCopyButtonTheme,
        // Collapse-bar styling for long fenced blocks (fenced-code-collapse-widget.ts).
        // An EditorView.theme like quollCopyButtonTheme so it overrides CM's
        // unlayered `.cm-line` rules — see cm/theme.ts.
        quollCollapseToggleTheme,
        quollSyntaxReveal(),
        // Fold gutter (PURE UI activation: codeFolding + foldGutter +
        // quollFoldKeymap). Fold ranges come from two places: heading sections via
        // Quoll's own re-implementation of lang-markdown's headerIndent
        // foldService (in cm/markdown.ts — re-implemented to avoid the markdown()
        // wrapper's HTML language stack), and list items + GFM tables via
        // lang-markdown's foldNodeProp on markdownLanguage.parser, MINUS the
        // Blockquote/Paragraph/code-block subtraction (nonFoldableBlocks, also in
        // cm/markdown.ts) so those show no chevron — both dormant until codeFolding
        // mounts.
        // Auto-unfold on caret/edit is
        // native (foldState clears folds under the selection head). View-layer
        // only — folds are foldState decorations, byte-identical round-trip.
        // Chevron placed beside the centred reading column by cm/theme.ts's
        // group-centring.
        quollFolding(),
        // Advisory Markdown lint: a debounced ViewPlugin re-lints the raw doc off
        // the keystroke path and publishes findings via a StateEffect; the field
        // underlines them (wavy, severity-coloured) with a hover message.
        // Display-only (byte-identical round-trip) and independent of the host
        // write-gate — it never imports validate-for-write and never blocks a
        // write. It parses the raw doc itself, so its order relative to the
        // language field is irrelevant to correctness.
        quollLint(postLintDiagnostics),
        // Opt-in advisory-lint gutter (cm/lint/gutter.ts). Held in a
        // Compartment that defaults EMPTY so the centred reading column is
        // pixel-identical until the host pushes editor-config(lintGutter:true)
        // via shell.setLintGutter. A read-only view of lintField — no document
        // mutation, no write-gate coupling.
        lintGutterCompartment.of([]),
        // Opt-in autofix: Mod-. applies the fix descriptor of the lint findings
        // on the current line(s) (currently only no-trailing-spaces). The command
        // re-lints fresh and is the SINGLE byte-changing path — display-only lint
        // never mutates on its own. The fix rides the normal dispatch -> edit-sync
        // -> host write-lock pipeline. Prec.high, focus-scoped — see
        // cm/lint/apply-fix.ts for the non-collision reasoning vs VS Code's Quick Fix.
        quollLintFixKeymap(),
        // Publishes `--quoll-prose-space` (the prose font's measured space
        // advance) that listHangIndent's source-column geometry references, so
        // wrapped nested-list lines align under the item text in the proportional
        // body font instead of over-indenting. Order before listHangIndent is
        // cosmetic (the var is read by CSS at paint, not by JS) but keeps the
        // metric producer next to its consumer.
        proseSpaceMetric,
        // List soft-wrap hanging indent: line decorations (text-indent +
        // padding) so wrapped bullet/ordered/task continuation lines hang
        // under the item content. Standalone (not folded into
        // quollSyntaxReveal, which arbitrates INLINE reveals vs block zones;
        // this is line-only and selection-independent).
        listHangIndent,
        // Heading vertical rhythm: a line decoration adding per-level `padding-top`
        // ABOVE top-level headings (Notion-style breathing room). Standalone like
        // listHangIndent (line-only), but SELECTION-INDEPENDENT — the space stays
        // regardless of the caret. The matching fold-gutter offset ships in
        // cm/fold/index.ts (headingRhythmFoldGutterLineClass) so the chevron stays
        // aligned; both halves share heading-rhythm.ts's headingRhythmLevel predicate.
        headingRhythm,
        // Block line decorations. `blockStyle` bundles two ViewPlugins:
        // blockquoteRule (selection-INDEPENDENT EXCEPT that a caret move re-walks
        // it too when a blockquote has a concealable fence at a boundary — the
        // cached-flag gate) + fencedCodePanel (selection-aware — a concealed fence
        // row collapses and the panel edge follows the first/last VISIBLE line).
        // Split so a caret move re-walks only the fenced pass in the common
        // (no-boundary-fence) case. Both emit Decoration.line; CodeMirror unions
        // their classes on a shared `> ```…` ` line. Styled by quollBlockStyleTheme above.
        blockStyle,
        // Caret-outside conceal of the [!TYPE] marker row; publishes its span to
        // quollSyntaxExclusionZones (block-style then migrates the -open corner
        // onto the first visible body line, and the orchestrator drops inline
        // marks on the row). Block widgets MUST come from a StateField.
        calloutMarkerConcealField,
        // Copy-code button: a selection-independent ViewPlugin emitting one
        // inline point widget at each top-level fenced block's open line; the
        // button copies the code body via navigator.clipboard. Display-only
        // (byte-identical round-trip) and absent in read-only mode.
        fencedCodeCopyButton,
        // Collapse long fenced blocks (>10 body lines): a block Decoration.replace
        // conceals body lines 11..N behind a "Show more" bar; "Show more"/"Show less"
        // toggle a per-block StateEffect. Block widgets MUST come from a StateField,
        // not a ViewPlugin. Display-only (byte-identical round-trip). Does NOT
        // contribute to quollBlockReplaceZones — the zone is non-atomic and the
        // caret reaches concealed lines via auto-expand (fold parity), not the
        // generic block-zone arrow keymap. Top-level blocks only (same gate as the
        // copy button above).
        fencedCodeCollapseField,
        // Bounded Table-node skeleton — precedes tableBlockField so buildAll
        // reads it via state.field() instead of a per-keystroke full walk.
        tableSkeletonField,
        // C6b: block widget for GFM tables. Publishes its range to
        // quollBlockReplaceZones so quollSyntaxReveal above drops inline
        // marks inside the widget; CodeMirror requires block widgets
        // come from a StateField, not a ViewPlugin.
        tableBlockField,
        // C7: block widget for standalone images. Same StateField pattern as
        // tableBlockField — publishes its range to quollBlockReplaceZones so
        // quollSyntaxReveal drops inline marks inside the widget and
        // blockZoneArrowKeymap (below) navigates across it. The src routes
        // through the render-gate: allowlisted → live <img>, non-allowlisted →
        // inert placeholder. img-src stays locked (CSP unchanged): relative
        // images load via webview-resource URIs already covered by cspSource;
        // remote (http(s)) pixels stay CSP-blocked pending the dedicated
        // remote-image PR.
        imageBlockField,
        quollResourceBaseUri.of(opts.resourceBaseUri ?? ""),
        // C8a: read-only block widget for a file-leading YAML frontmatter
        // fence. Detection is line-native (cm/frontmatter/detect.ts), not a
        // Lezer-tree walk — frontmatter is not a CommonMark construct. The
        // fence span is block-replaced and made atomic (caret skips it); the
        // table/image fields above are guarded to not emit inside its span.
        // Render-only → byte-identical round-trip. Click/caret-to-edit reveal
        // is the C8b layer; this slice does NOT contribute to
        // quollBlockReplaceZones (no reveal navigation).
        frontmatterBlockField,
        // C8b: Prec.high ArrowUp revealing the collapsed frontmatter block when
        // the caret would step up into it (the block is atomic when collapsed).
        // Reveal is stateful (an effect), so this is frontmatter-specific, not
        // the generic blockZoneArrowKeymap. Click-to-reveal is the widget's
        // mousedown; re-collapse on caret-leave is selection-driven.
        frontmatterRevealKeymap(),
        // C6b follow-up: Prec.high ArrowUp/Down intercept that lands the
        // caret on a block-zone's first/last source line instead of CM's
        // default atomic skip. Reads quollBlockReplaceZones (contributed by
        // tableBlockField + imageBlockField above). Generic over the facet.
        blockZoneArrowKeymap(),
        // Tab / Shift-Tab list indent: in a bullet/ordered/task ListItem, Tab
        // nests the item under its preceding sibling and Shift-Tab promotes it.
        // Outside a list (or in code) it is a no-op that still returns true, so
        // Tab never escapes to VS Code focus navigation. Prec.high so it wins
        // before CM's default. Edits raw source → normal edit-sync path.
        listIndentKeymap(),
        // Enter on an unclosed ```-fence opener auto-inserts a matching closing
        // fence and lands the caret on the empty body line between the two, so a
        // fence typed mid-document no longer reflows every following line into
        // code until EOF. Prec.high so it is tried before CM's default Enter; it
        // returns false for every non-trigger (inline code / inside-block /
        // already-closed) so the default newline still runs. One ordinary
        // transaction → normal edit-sync path, byte-identical round-trip.
        fencedCodeEnterKeymap(),
        // Register AFTER quollSyntaxReveal so the reveal decoration build
        // precedes mousedown handling on the same update — the click path
        // reads syntaxTree to resolve the position to a Link node and
        // benefits from any decorations the reveal already arbitrated.
        quollLinkClickHandler(getHost()),
        // Cmd+Option+K → Claude Code handoff; Cmd+J → Codex handoff. One
        // Prec.high keymap (see cm/context-handoff.ts) scoped to CM focus — no
        // package.json keybinding. Cmd+Option+K never collides with Claude's
        // editorTextFocus binding; Cmd+J is claimed here before the workbench
        // togglePanel (verified in smoke; fallback stopPropagation → Mod-Alt-j).
        // Flushes the pending debounced Edit before posting so the handoff never
        // ships pre-keystroke line refs. Uses flushIfIdle (single-flight-
        // respecting), NOT switch-editor's teardown flush, because the panel
        // stays alive after a handoff and a force-post could be reseed-clobbered.
        quollContextHandoffKeymap(getHost(), () => sync.flushIfIdle()),
        // Document outline navigator: a webview-native overlay panel (toggle
        // button + Mod-Alt-o) listing the doc's ATX headings; clicking one
        // dispatches a selection-only jump (byte-preserving) and focuses the
        // editor. View-only; rebuild is gated on the panel being open AND
        // debounced so the keystroke path is untouched. Present in read-only
        // mode too (navigation, not editing).
        quollOutline(),
        // Quoll → text-editor switch: a top-right overlay button + the
        // ⌘⌥E / Ctrl+Alt+E chord, both posting `switch-to-text`. Pure side channel
        // (no CM change, no write-lock); the host reopens the document in the
        // built-in text editor and re-applies the caret. Present in read-only
        // mode too (navigation).
        quollSwitchEditor(getHost(), () => sync.flush()),
        // Floating-toolbar scroll-hide: one shared scroll-direction observer on
        // view.scrollDOM stamps `.quoll-chrome-hidden` on the .quoll-editor host
        // so BOTH toggles above + the outline panel slide off the top edge on
        // scroll-down and return on scroll-up / at the top. Display-only chrome
        // (no CM change, no write-lock); the two toggle ViewPlugins are untouched.
        quollFloatingToolbarScroll(),
        // Paste/drop image ingestion: capture image files, post image-write, and
        // insert the relative link at a position-mapped anchor on the host's
        // reply. canWrite mirrors edit-sync's readonly hard-drop; the host is the
        // authoritative gate (sniff + size cap + read-only).
        imagePaste.extension,
        EditorView.lineWrapping,
        lineSepComp.of(EditorState.lineSeparator.of("\n")),
        editableComp.of([
          EditorView.editable.of(initialCanWrite),
          EditorState.readOnly.of(!initialCanWrite),
        ]),
        EditorView.updateListener.of((u) => {
          const updateStart = QUOLL_PERF ? perfNow() : 0;
          if (u.docChanged && !seeding) {
            // Reject-recovery: when the host has rejected the prior Edit,
            // the next user keystroke is their retry intent. Two ops in
            // STRICT order before scheduling the debounced flush:
            //   1. discardBuffer — the pre-reject buffered bytes are
            //      stale (same content the host just rejected); the
            //      synchronous onReducerCommit → replayIfNeeded chain
            //      that fires INSIDE the local-edit-attempt dispatch
            //      below would otherwise post them again and the
            //      banner would flicker. ORDER IS LOAD-BEARING.
            //   2. dispatch(local-edit-attempt) — clears the gate via
            //      the reducer; drain sees empty buffer (step 1) → no-op.
            // Then onLocalChange's debounce reads FRESH getDoc() — which
            // includes the keystroke that just fired this updateListener —
            // and ships a retry on the next timer tick. The order
            // regression is pinned by the "synchronous drain does NOT
            // replay stale buffered bytes" test above.
            if (opts.getState().serializeError !== null) {
              sync.discardBuffer();
              opts.dispatch({ type: "local-edit-attempt" });
            }
            sync.onLocalChange();
          }
          // Caret handoff: report the caret on any selection change. Suppressed
          // during host seeds (`seeding` — the reseed restores a selection, not
          // a user move) and during applyRemoteCaret (`applyingRemoteCaret` —
          // the just-applied caret must not echo back). `selectionSet` covers
          // both pure caret moves and typing (a doc change moves the caret too).
          if (u.selectionSet && !seeding && !applyingRemoteCaret) {
            postCaretReport(selectionToCaret(u.state));
          }
          if (QUOLL_PERF) {
            perfRecord("webview:update-listener", perfNow() - updateStart);
          }
        }),
      ],
    }),
  });
  if (QUOLL_PERF) {
    perfRecord("webview:view-create", perfNow() - viewCreateStart);
  }

  function setReadOnlyClass(canWrite: boolean): void {
    mount.classList.toggle("read-only", !canWrite);
  }

  return {
    applyDocument(rawText, canWrite, baseDocVersion) {
      // Cancel a scheduled flush BEFORE writing the snapshot so a pending
      // debounced Edit cannot post the host's own bytes back — this also
      // captures an in-window keystroke into the buffer so it survives
      // the reseed and replays on the ack.
      sync.cancelPendingFlush();
      const needsReseed = view.state.sliceDoc() !== rawText;
      // Capture BEFORE the reseed. The needsReseed branch issues a wholesale
      // `0..doc.length` replace; CodeMirror's default selection mapping
      // collapses mid-doc cursors through that delete (the typical
      // accept-mid-typing race lands them at position 0). We re-set the
      // caret in the SAME transaction below, clamped to the new doc bounds,
      // so typing through an accept boundary keeps the edit point — and the
      // atomic doc+editable contract (test "l") still holds because it is
      // one dispatch.
      const prevSelection = needsReseed ? view.state.selection : null;
      // Compute the inserted Text once so we can read its length for the
      // selection clamp WITHOUT depending on a post-dispatch state read —
      // selection is applied in resulting-doc coords inside this single
      // transaction. splitToCmText's length is what view.state.doc.length
      // will be after the change lands — the LF-internal UTF-16 code unit
      // count (the split strips a CRLF's \r), which is exactly what CM
      // selection positions are measured in. Do NOT substitute rawText.length
      // here; see cm/seed.ts for the byte rationale.
      const insertText = needsReseed ? splitToCmText(rawText) : null;
      const newDocLength = insertText !== null ? insertText.length : view.state.doc.length;
      const prevMain = prevSelection?.main;
      seeding = true;
      try {
        view.dispatch({
          // Host seeds are document-level snapshots, not user actions —
          // exclude them from undo history. hostDocumentReseed lets the
          // frontmatter state machine distinguish a reseed from user edits
          // (and from other addToHistory=false transactions).
          annotations: [Transaction.addToHistory.of(false), hostDocumentReseed.of(true)],
          effects: [
            lineSepComp.reconfigure(EditorState.lineSeparator.of(detectLineSeparator(rawText))),
            editableComp.reconfigure([
              EditorView.editable.of(canWrite),
              EditorState.readOnly.of(!canWrite),
            ]),
          ],
          ...(insertText !== null
            ? {
                changes: {
                  from: 0,
                  to: view.state.doc.length,
                  // Pre-split on /\r\n?|\n/ so the line model is clean
                  // regardless of facet timing.
                  insert: insertText,
                },
              }
            : {}),
          // Restore ONLY the main range, clamped to new doc bounds.
          // Multi-cursor users mid-accept-race are vanishingly rare in a
          // markdown editor — KISS over collapse-prevention. Without
          // this, CM's default change-mapping lands mid-doc cursors at 0.
          ...(prevMain !== undefined
            ? {
                selection: {
                  anchor: Math.min(prevMain.anchor, newDocLength),
                  head: Math.min(prevMain.head, newDocLength),
                },
              }
            : {}),
        });
      } finally {
        // try/finally: if dispatch throws, seeding must NOT stay stuck
        // true — a stuck guard permanently suppresses the updateListener's
        // echo-Edit detection.
        seeding = false;
      }
      sync.onHostSnapshot(baseDocVersion, canWrite);
      setReadOnlyClass(canWrite);
    },
    resolveImageWrite(requestId, relativePath) {
      imagePaste.resolve(view, requestId, relativePath);
    },
    setLintGutter(enabled) {
      // Same-value no-op guard. The host posts editor-config at BOTH eager-seed
      // and `ready` (so delivery survives whichever handshake wins), and again
      // on every relevant onDidChangeConfiguration — without this guard each
      // duplicate would reconfigure the compartment and churn the gutter DOM.
      // Ordering correctness across the duplicates rests on the single FIFO
      // host->webview channel + the host always reading LIVE config at post
      // time, so the last post carries the newest value and wins — no
      // version/sequence field is needed for a boolean display pref (Codex
      // review finding 4).
      if (enabled === lintGutterEnabled) {
        return;
      }
      lintGutterEnabled = enabled;
      view.dispatch({
        effects: lintGutterCompartment.reconfigure(enabled ? lintGutterExtension : []),
      });
    },
    applyRemoteCaret(caret) {
      const anchor = applyCaret(view.state.doc, caret);
      // Same-position no-op guard: if the caret is already there, skip the
      // dispatch (avoids a redundant scroll + a suppressed-but-pointless cycle).
      // Focus is NOT gated on this — see below.
      const alreadyThere =
        view.state.selection.main.empty && view.state.selection.main.head === anchor;
      applyingRemoteCaret = true;
      try {
        // Paint the caret. CodeMirror only draws the cursor while the view is
        // focused (`.cm-focused`; @codemirror/view hides `.cm-cursor` otherwise).
        // This is the reverse editor-switch handoff: the host posts caret-apply
        // while the webview iframe owns focus but CM's contenteditable does not,
        // so without an explicit focus the carried caret is set-but-invisible
        // ("caret not shown after switching to Quoll"). Focus even when the
        // position is unchanged, so the caret still becomes visible.
        //
        // Gate on document.hasFocus(): the active-edge caret-apply fires whenever
        // the host panel flips active, which is "active editor of the active
        // group" — NOT DOM focus. Some reactivations happen while the user's
        // focus is deliberately elsewhere (the ⌘⌥K reveal-for-mention cleanup
        // closes its temp text tab and re-activates this panel while focus is on
        // the Claude composer), and focusing unconditionally would steal
        // keystrokes into the document. When this webview already owns focus (the
        // deliberate text→Quoll switch this fix targets) document.hasFocus() is
        // true, so the caret is painted exactly when it should be.
        //
        // `focus()` uses preventScroll and posts no transaction, so it neither
        // scrolls nor echoes a caret-report; kept inside the suppression window
        // defensively so any focus-driven selection sync cannot bounce back.
        if (document.hasFocus()) {
          view.focus();
        }
        if (!alreadyThere) {
          // Selection-only dispatch (no `changes`) → docChanged is false, so the
          // edit-sync path is never touched and no Edit is posted. scrollIntoView
          // brings the carried caret into view, matching the text-editor side's
          // revealRange. Pattern mirrors block-zone-arrow-keymap's caret dispatch.
          view.dispatch({ selection: { anchor }, scrollIntoView: true });
        }
      } finally {
        // try/finally so a throw cannot leave the flag stuck true (which would
        // permanently suppress caret-report) — same discipline as `seeding`.
        applyingRemoteCaret = false;
      }
    },
    onReducerCommit(editInFlight) {
      sync.onReducerCommit(editInFlight);
    },
    flushPendingEdit() {
      sync.flush();
    },
    dispose() {
      // Cancel the pending debounced flush BEFORE tearing the view down.
      // A timer that fires after destroy would call getDoc() through a
      // destroyed view; the empty-string Edit it would post must never
      // ship.
      sync.cancelPendingFlush();
      // try/finally so mount.remove() runs even if view.destroy() throws.
      // Without this, a destroy-time throw would leak the
      // <div class="quoll-editor"> in the DOM and the next mountEditor in
      // a test would double-mount.
      try {
        view.destroy();
      } finally {
        mount.remove();
      }
    },
  };
}
