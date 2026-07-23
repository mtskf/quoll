// Vanilla CodeMirror mount.
//
// The drain (onReducerCommit) is the SOLE entry point that fires
// edit-sync's replayIfNeeded — the shell calls it synchronously from its
// dispatch wrapper after every state-changing transition. This is what
// guarantees no missed trigger; `replayIfNeeded`'s in-flight / consent
// guards inside edit-sync.ts handle re-entry.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { perfNow, perfRecord } from "../shared/perf.js";
import {
  type LintDiagnosticWire,
  MAX_CONTENT_LENGTH,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../shared/protocol.js";
import { applyCaret, type Caret, selectionCharCount, selectionToCaret } from "./cm/caret.js";
import { quollCodeRefClickHandler } from "./cm/code-ref/code-ref-handlers.js";
import { quollContextHandoffKeymap } from "./cm/context-handoff.js";
import { blockStyle } from "./cm/decorations/block-style.js";
import { blockZoneArrowKeymap } from "./cm/decorations/block-zone-arrow-keymap.js";
import { calloutMarkerConcealField } from "./cm/decorations/callout-marker-conceal.js";
import { headingRhythm } from "./cm/decorations/heading-rhythm.js";
import { quollSyntaxReveal } from "./cm/decorations/index.js";
import { proseSpaceMetric } from "./cm/decorations/prose-space-metric.js";
import { createEditSync } from "./cm/edit-sync.js";
import { type EditorPrefs, editorPrefsField, setEditorPrefsEffect } from "./cm/editor-prefs.js";
import { editorPrefsApply } from "./cm/editor-prefs-apply.js";
import { fencedCodeCollapseField } from "./cm/fenced-code/fenced-code-collapse.js";
import { fencedCodeCopyButton } from "./cm/fenced-code/fenced-code-copy-button.js";
import { fencedCodeEnterKeymap } from "./cm/fenced-code/fenced-code-enter-keymap.js";
import { quollCodeHighlighting } from "./cm/fenced-code/fenced-code-highlight-languages.js";
import { fencedCodeLanguagePicker } from "./cm/fenced-code/fenced-code-language-picker.js";
import { quollFloatingToolbarScroll } from "./cm/floating-toolbar-scroll.js";
import { quollFolding } from "./cm/fold/index.js";
import { frontmatterBlockField, frontmatterRevealKeymap } from "./cm/frontmatter/index.js";
import { hostDocumentReseed } from "./cm/host-reseed.js";
import { createImagePasteDrop, imageBlockField, quollResourceBaseUri } from "./cm/image/index.js";
import {
  type FormatAction,
  runFormatCommand as runInlineFormat,
} from "./cm/inline/inline-formatting-commands.js";
import { quollLinkClickHandler } from "./cm/link-handlers.js";
import { quollLintFixKeymap } from "./cm/lint/apply-fix.js";
import { quollLintGutter } from "./cm/lint/gutter.js";
import { proseLintEnabled, quollLint } from "./cm/lint/index.js";
import { listContinuationKeymap } from "./cm/list/list-continuation-keymap.js";
import { listHangIndent } from "./cm/list/list-hang-indent.js";
import { listIndentKeymap } from "./cm/list/list-indent-keymap.js";
import { quollMarkdownLanguage } from "./cm/markdown.js";
import { openExternalSinkFor, quollOpenExternalSink } from "./cm/open-external.js";
import { quollOutline } from "./cm/outline/index.js";
import { quollUpdateConfigSink, updateConfigSinkFor } from "./cm/outline/update-config-sink.js";
import { htmlTablePaste, listReindentPaste, pasteUrlOverSelection } from "./cm/paste/index.js";
import { detectLineSeparator, splitToCmText } from "./cm/seed.js";
import { quollSwitchEditor } from "./cm/switch-editor.js";
import { tableBlockField, tableSkeletonField } from "./cm/table/index.js";
import {
  quollBlockStyleTheme,
  quollBulletMarkerTheme,
  quollCmLinePaddingTheme,
  quollCollapseToggleTheme,
  quollCopyButtonTheme,
  quollFencedHeaderBarTheme,
  quollHeadingRhythmTheme,
  quollHighlighting,
  quollSearchPanelTheme,
  quollTaskCompletedContentTheme,
  quollTheme,
  quollTokenMarkers,
} from "./cm/theme.js";
import { quollVisibleEdgeRecovery } from "./cm/visible-edge-recovery.js";
import { getHost } from "./host.js";
import { safePostMessage } from "./safe-post-message.js";
import { type Action, canPostEdit, type WebviewState } from "./state.js";

type Dispatch = (action: Action) => void;

// Trailing-debounce window for `caret-report`. `selectionSet` fires on every
// keystroke and every drag-selection tick; the host keeps only the latest
// (`lastKnownCaret`), so coalescing to one trailing post per settle bounds the
// traffic without changing what the host ultimately reads. Shorter than
// edit-sync's DEBOUNCE_MS (300 ms) because a caret is a single {line,character}
// and the pre-switch / teardown flush is the real correctness guarantee — this
// window only trims the mid-move flood.
const CARET_REPORT_DEBOUNCE_MS = 100;

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
  /** Teardown/hide flush: push any pending (typed-but-undebounced) Edit AND the
   *  debounced caret-report to the host immediately. Wired by the shell to
   *  visibilitychange:hidden / pagehide / blur so a close cannot silently drop
   *  the last keystrokes OR strand the final caret inside its debounce window.
   *  Single-flight-safe (delegates to edit-sync's flush → trySend). */
  flushPending(): void;
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
  /** Toggle the opt-in advisory PROSE lint rules (passive-voice / filler-words /
   *  long-sentence). Reconfigures the prose-lint Compartment so the proseLintEnabled
   *  facet flips; the debounced lint compute re-runs within one debounce window,
   *  adding/clearing the prose underlines. Driven by the host's editor-config push. */
  setProseLint(enabled: boolean): void;
  /** Toggle the native (Electron) spellchecker on the contenteditable surface.
   *  Reconfigures a Compartment holding `EditorView.contentAttributes` so the
   *  `spellcheck` attribute on `.cm-content` flips true/false. Driven by the
   *  host's editor-config push; whether the red underlines actually paint is
   *  the webview host's (VS Code/Electron) call, not ours. */
  setSpellcheck(enabled: boolean): void;
  /** Apply the host-pushed editor-surface presets. NOT same-value-guarded — a
   *  same-value push is the pending-clear signal (see the setter body). Driven
   *  by editor-config. */
  setEditorPrefs(prefs: EditorPrefs): void;
  /** Run an inline-format action on the current selection. Rides the normal
   *  dispatch -> edit-sync pipeline; a no-op when the view is read-only. */
  runFormatCommand(action: FormatAction): void;
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
  try {
    dispatch({ type: "post-edit" });
  } catch (dispatchErr) {
    console.error("[quoll] post-edit dispatch itself failed", dispatchErr);
  }
  const message: WebviewToHost = {
    protocol: PROTOCOL_VERSION,
    type: "edit",
    content,
    baseDocVersion,
  };
  const postStart = QUOLL_PERF ? perfNow() : 0;
  const ok = safePostMessage(getHost(), message, "edit", (err) => {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      dispatch({
        type: "serialize-error",
        error: { code: "internal_error", message: `Could not send edit to host: ${detail}` },
      });
    } catch (dispatchErr) {
      // Not a reducer throw (state.ts's serialize-error case is a pure spread
      // and cannot throw) — state.editInFlight is already committed false by
      // the time this catches. The realistic source is shell.ts's dispatch
      // side effects: renderBanners' DOM write, or the synchronous re-entrant
      // drain (onReducerCommit -> edit-sync.replayIfNeeded -> postEditMessage).
      // In that case editInFlight recovers correctly, but the "Cannot save"
      // banner never reached the DOM for this tick — log it so that failure
      // mode is diagnosable.
      console.error(
        "[quoll] serialize-error dispatch itself failed (banner may not have rendered)",
        dispatchErr
      );
    }
  });
  if (ok && QUOLL_PERF) {
    perfRecord("webview:postMessage", perfNow() - postStart);
  }
  return ok;
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
  // Opt-in advisory prose-lint gate: a Compartment holding the proseLintEnabled
  // facet value, reconfigured by the host's editor-config push (setProseLint
  // below). Defaults to `false` (matching the quoll.lint.prose.enabled default),
  // so the prose rules stay dormant until the host pushes the live setting.
  const proseLintCompartment = new Compartment();
  // Native-spellcheck toggle: a Compartment holding EditorView.contentAttributes
  // so the `spellcheck` attribute on the contenteditable `.cm-content` flips.
  // Reconfigured by the host's editor-config push (setSpellcheck below).
  const spellcheckCompartment = new Compartment();
  const spellcheckAttrs = (enabled: boolean) =>
    EditorView.contentAttributes.of({ spellcheck: String(enabled) });
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
  // Mirrors the prose-lint compartment's default-off state so a redundant same-
  // value push (the eager-seed + ready double-send, or an unrelated config
  // change) is a no-op instead of a churn-inducing reconfigure — same posture as
  // the gutter. Named distinctly from the `proseLintEnabled` facet to avoid shadowing.
  let proseLintOn = false;
  // Mirrors the spellcheck compartment's initial state (default ON, matching
  // the `quoll.editor.spellcheck` default) so a redundant same-value push is a
  // no-op instead of a churn-inducing reconfigure — same posture as the gutter.
  let spellcheckEnabled = true;

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
    safePostMessage(getHost(), message, "lint-diagnostics");
  };

  // Report the current caret to the host on every selection change (one-shot
  // side channel; the host keeps only the latest for the Quoll→text-editor
  // handoff). Failures are logged and swallowed — a dropped report just means
  // the host carries a slightly older caret on the next switch, never data loss.
  const postCaretReport = (caret: Caret, selectedChars: number): void => {
    const message: WebviewToHost = {
      protocol: PROTOCOL_VERSION,
      type: "caret-report",
      line: caret.line,
      character: caret.character,
      selectedChars,
    };
    safePostMessage(getHost(), message, "caret-report");
  };

  // caret-report trailing debounce. The updateListener schedules the latest
  // caret rather than posting each `selectionSet`; the timer coalesces a burst
  // (typing, drag-selection) into one post CARET_REPORT_DEBOUNCE_MS after it
  // settles. flushCaretReport posts the pending caret NOW at the pre-switch and
  // teardown/hide boundaries — mirroring edit-sync's flush — so the caret the
  // host applies on the Quoll→text switch is the final one, never a report
  // stranded inside the debounce window. (A mid-window report the user overtypes
  // is dropped by design, within the documented tolerance: a slightly older
  // caret on the next switch, never data loss — see postCaretReport above.)
  let pendingCaret: { caret: Caret; selectedChars: number } | null = null;
  let caretTimer: ReturnType<typeof setTimeout> | null = null;
  const clearCaretTimer = (): void => {
    if (caretTimer !== null) {
      clearTimeout(caretTimer);
      caretTimer = null;
    }
  };
  const emitPendingCaret = (): void => {
    if (pendingCaret !== null) {
      const { caret, selectedChars } = pendingCaret;
      pendingCaret = null;
      postCaretReport(caret, selectedChars);
    }
  };
  const scheduleCaretReport = (caret: Caret, selectedChars: number): void => {
    pendingCaret = { caret, selectedChars }; // latest-wins; the burst collapses to one post
    clearCaretTimer();
    caretTimer = setTimeout(() => {
      caretTimer = null;
      emitPendingCaret();
    }, CARET_REPORT_DEBOUNCE_MS);
  };
  // Post the pending caret immediately and cancel the trailing timer (so no
  // duplicate post follows). Fired by the switch button/chord flush callback
  // and by the teardown/hide flush (flushPending).
  const flushCaretReport = (): void => {
    clearCaretTimer();
    emitPendingCaret();
  };
  // Drop a pending caret WITHOUT posting — dispose only. The teardown-signal
  // flushes (visibilitychange:hidden / pagehide / blur → flushPending) already
  // delivered the final caret while the transport was live; this just prevents a
  // stray post from a timer that would otherwise outlive the destroyed view.
  const cancelCaretReport = (): void => {
    clearCaretTimer();
    pendingCaret = null;
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
        // In-editor find & replace over the raw-Markdown text canonical
        // (@codemirror/search core module). `search({ top: true })` mounts the
        // panel at the top (VS Code-like). A replace is an ordinary transaction,
        // so it rides the normal updateListener → edit-sync → host write-lock →
        // validate-for-write pipeline (no raw write path); a gate-rejecting
        // replacement surfaces edit-rejected like any other edit. In read-only
        // mode CM's replace commands return false and the panel omits its replace
        // UI (both guard on EditorState.readOnly, set when canWrite=false), so
        // there is no UI/host divergence. highlightSelectionMatches underlines
        // other occurrences of the current selection. The panel's runtime <style>
        // is nonce-covered by EditorView.cspNonce above, so CSP is unchanged.
        //
        // searchKeymap accepted chords (documented so a future upstream addition
        // is a conscious review point, per plan review): Mod-f open panel;
        // F3 / Mod-g next (Shift → previous); Escape close (panel-scoped);
        // Mod-Shift-l select all matches; Mod-Alt-g go-to-line; Mod-d select next
        // occurrence. None collide with Quoll's existing chords. Enter / Shift-Enter
        // cycling is the panel field's own handler, not this keymap. Prec.high
        // matches the house convention for focus-scoped editor chords
        // (apply-fix / context-handoff / list-indent keymaps) and defends Mod-f
        // against any future defaultKeymap addition. Styled by quollSearchPanelTheme
        // below (an EditorView.theme — the CM search panel base styles are injected
        // UNLAYERED, which styles.css's @layer rules cannot beat; see cm/theme.ts).
        search({ top: true }),
        Prec.high(keymap.of(searchKeymap)),
        highlightSelectionMatches(),
        quollSearchPanelTheme,
        quollMarkdownLanguage(),
        quollTheme,
        // Quoll owns the `.cm-line` start padding via --quoll-column-inset-left
        // (cm/theme.ts). An EditorView.theme so the single-class `.cm-line` rule
        // beats CM's unlayered baseTheme `.cm-line { padding: 0 2px 0 6px }` by
        // cascade order — the same token the list-hang decoration reads as its
        // hang base, so base padding and hang move together. See cm/theme.ts.
        quollCmLinePaddingTheme,
        quollHighlighting,
        // Language-scoped sub-language token colours inside fenced code (theme.ts
        // spec, scoped per nested language in fenced-code-highlight-languages.ts).
        // Display-only; scoped so it never styles Markdown prose. Array (one scoped
        // layer per language) → spread.
        ...quollCodeHighlighting,
        // Style-free marker layer: tags strong/link spans with stable classes so
        // the nascent-setext reset can spare their bold/colour (see cm/theme.ts).
        quollTokenMarkers,
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
        // Header-bar layout for language-tagged fences (reserved strip + gradient
        // bar + labelled picker <select>, incl. the picker's own box model). An
        // EditorView.theme like quollCopyButtonTheme so it overrides CM's unlayered
        // `.cm-line` rules — see cm/theme.ts.
        quollFencedHeaderBarTheme,
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
        // Opt-in advisory prose-lint gate. The proseLintEnabled facet drives
        // whether the engine runs the prose rules; held in a Compartment so the
        // host's editor-config push (setProseLint) can flip it at runtime.
        // Defaults false (matching quoll.lint.prose.enabled) so no prose
        // underlines appear until the host pushes the live setting. Display-only.
        proseLintCompartment.of(proseLintEnabled.of(false)),
        // Native-spellcheck attribute, held in a Compartment so the host's
        // editor-config push can flip `spellcheck` on the contenteditable
        // `.cm-content` at runtime. Defaults ON (matching quoll.editor.spellcheck)
        // so the native red underlines light up out of the box; the host re-pushes
        // the live setting on seed/ready/change. Display-only — no document mutation.
        spellcheckCompartment.of(spellcheckAttrs(true)),
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
        // Language picker: a selection-independent ViewPlugin emitting one inline
        // point widget per fenced block's open line; its <select> rewrites the
        // opening fence's language token via setFenceLanguage. The ONLY fenced-code
        // widget that mutates the document (one guarded info-string edit, byte-clean
        // otherwise). Absent in read-only mode, same as the copy button.
        fencedCodeLanguagePicker,
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
        // Enter in a bullet/ordered/task list item continues the marker on the
        // next line; Enter on an empty marker line removes it (exiting the list);
        // ordered runs renumber to stay sequential. Registered BEFORE the
        // fenced-code Enter so a normal list line is handled here, while a fence
        // opener on a list marker line (`- ```\`) is deferred (caretInCode guard)
        // to fencedCodeEnterKeymap. Prec.high; returns false for every non-list
        // caret so the default Enter still runs. One transaction → edit-sync path.
        listContinuationKeymap(),
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
        // Independent mousedown handler for the workspace-relative code-
        // reference affordance (`src/foo.ts:42` inside inline code). Coexists
        // with quollLinkClickHandler above: a click on a plain code reference
        // resolves no Link (that handler returns false) and this handler
        // consumes it; a code reference NESTED in a link (`` [`x`](y.md) ``)
        // is deferred by this handler's own Link-ancestor guard, so the link
        // handler's click still wins.
        quollCodeRefClickHandler(getHost()),
        // Provide the open-external sink read by the readonly table widget's
        // modifier-click path (cm/table/table-widget.ts). Same host choke
        // point as quollLinkClickHandler above — the widget is built inside a
        // StateField and cannot be dependency-injected at construction, so it
        // reads this facet at click time. Forgetting this `.of(...)` makes the
        // facet fall back to its no-op default → table links silently stop
        // opening on modifier-click (caught by the manual smoke below).
        quollOpenExternalSink.of(openExternalSinkFor(getHost())),
        // Provide the update-config sink read by the outline settings popover
        // (cm/outline/settings-popover.ts) — same injected-facet pattern as the
        // open-external sink above (the popover lives in a ViewPlugin and reads
        // this at click time). Forgetting it falls back to the no-op default →
        // settings clicks silently do nothing.
        quollUpdateConfigSink.of(updateConfigSinkFor(getHost())),
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
        // Editor-preset settings: the field holds the 4 preset ids (default =
        // today's rendering); editorPrefsApply writes them as CSS vars on
        // view.dom. Driven by the host's editor-config push via setEditorPrefs
        // (last-write-wins over the single FIFO channel).
        editorPrefsField,
        editorPrefsApply(),
        // Quoll → text-editor switch: a top-right overlay button + the
        // ⌘⌥E / Ctrl+Alt+E chord, both posting `switch-to-text`. Pure side channel
        // (no CM change, no write-lock); the host reopens the document in the
        // built-in text editor and re-applies the caret. Present in read-only
        // mode too (navigation).
        quollSwitchEditor(getHost(), () => {
          // Pre-switch flush: push the latest pending Edit AND the debounced
          // caret-report to the host BEFORE switch-to-text, so the reopened
          // text editor shows the just-typed content with its caret at the
          // just-moved position (the host applies lastKnownCaret on the switch).
          // postSwitchToText posts switch-to-text AFTER this callback → FIFO.
          sync.flush();
          flushCaretReport();
        }),
        // Floating-toolbar scroll-hide: one shared scroll-direction observer on
        // view.scrollDOM stamps `.quoll-chrome-hidden` on the .quoll-editor host
        // so BOTH toggles above + the outline panel slide off the top edge on
        // scroll-down and return on scroll-up / at the top. Display-only chrome
        // (no CM change, no write-lock); the two toggle ViewPlugins are untouched.
        quollFloatingToolbarScroll(),
        // Visible-edge scroll/viewport recovery: when the webview is hidden and
        // re-shown (editor switch, ⌘⌥K handoff) CM's first measure can run
        // mid-reflow with the pinned outline, losing the scroll anchor and
        // leaving a viewport-sized .cm-gap over the visible area until the user
        // scrolls. The plugin keeps a rolling scroll snapshot (frozen across the
        // hidden window, mapped through doc changes) and restores + re-measures
        // once post-visible geometry settles. Display-only (no doc change, no
        // write-lock). Companion PAINT-side fix: the !important flex-basis in
        // cm/theme.ts (PR #199).
        quollVisibleEdgeRecovery(),
        // Smart paste: a clipboard `text/html` fragment containing a <table> is
        // converted to a GFM Markdown table and inserted through the normal edit
        // pipeline. Prec.high so it arbitrates before imagePaste / default paste;
        // on a non-table paste it returns false and defers. Grouped with the
        // other paste handlers below.
        htmlTablePaste({ canWrite: () => opts.getState().canWrite }),
        // Paste-URL-over-selection: a clipboard text that is exactly one http(s)
        // URL, pasted while a non-empty single-line selection exists, wraps the
        // selection as `[selection](url)`. Prec.high, deferring on every other
        // paste. Supersedes @codemirror/lang-markdown's built-in pasteURLAsLink
        // (dropped from quollMarkdownLanguage) with allowlist-aligned detection.
        pasteUrlOverSelection({ canWrite: () => opts.getState().canWrite }),
        // Paste re-indent: a multi-line plain-text Markdown LIST fragment pasted
        // at the start of a line inside an existing list context is re-based so
        // its top level aligns with the caret's column (Obsidian analogue), inner
        // structure preserved. Prec.high, deferring on every non-qualifying paste
        // (single-line, non-list fragment, fence-bearing, mid-line caret, caret
        // outside a list, tab-ambiguous) so htmlTablePaste / pasteUrlOverSelection
        // / imagePaste / CM's default plain-text paste still run.
        listReindentPaste({ canWrite: () => opts.getState().canWrite }),
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
          // Caret handoff: report the caret on any selection change (debounced —
          // see scheduleCaretReport). Suppressed during host seeds (`seeding` —
          // the reseed restores a selection, not a user move) and during
          // applyRemoteCaret (`applyingRemoteCaret` — the just-applied caret must
          // not echo back). `selectionSet` covers both pure caret moves and
          // typing (a doc change moves the caret too).
          if (u.selectionSet && !seeding && !applyingRemoteCaret) {
            scheduleCaretReport(selectionToCaret(u.state), selectionCharCount(u.state));
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
    setProseLint(enabled) {
      // Same-value guard lives ONLY here (dispatch-skip): the compute plugin
      // re-schedules purely on the facet value CHANGING, so a guarded no-op simply
      // never dispatches — no need to re-check the value downstream. Mirrors the
      // gutter's guard; the host posts editor-config at eager-seed + `ready` + on
      // every relevant config change, so duplicates must not churn the compartment.
      if (enabled === proseLintOn) {
        return;
      }
      proseLintOn = enabled;
      view.dispatch({
        effects: proseLintCompartment.reconfigure(proseLintEnabled.of(enabled)),
      });
    },
    setSpellcheck(enabled) {
      // Same-value no-op guard, mirroring setLintGutter: the host posts
      // editor-config at eager-seed AND `ready` (plus every relevant config
      // change), so a duplicate must not churn the compartment / re-render the
      // contenteditable attribute. Last-write-wins over the single FIFO channel.
      if (enabled === spellcheckEnabled) {
        return;
      }
      spellcheckEnabled = enabled;
      view.dispatch({
        effects: spellcheckCompartment.reconfigure(spellcheckAttrs(enabled)),
      });
    },
    setEditorPrefs(prefs) {
      // No same-value guard — a same-value push is the signal that clears the
      // popover's pending row (override / host-failure branches re-push the
      // unchanged snapshot). Fresh object each time ⇒ field identity changes ⇒
      // outline update() runs syncFromState(). Idempotent applier, no ping-pong.
      view.dispatch({ effects: setEditorPrefsEffect.of(prefs) });
    },
    runFormatCommand(action) {
      runInlineFormat(view, action);
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
    flushPending() {
      sync.flush();
      flushCaretReport();
    },
    dispose() {
      // Cancel the pending debounced flush BEFORE tearing the view down.
      // A timer that fires after destroy would call getDoc() through a
      // destroyed view; the empty-string Edit it would post must never
      // ship.
      sync.cancelPendingFlush();
      // Drop a pending caret post too — the teardown-signal flush already
      // delivered the final caret while the transport was live; canceling
      // prevents a stray post from a timer outliving the destroyed view.
      cancelCaretReport();
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
