// Host-side status-bar + caret-handoff WIRING for QuollEditorPanel. The pure
// pieces live in status-bar.ts (formatters + StatusBarController) and
// caret-handoff.ts (clampCaret) and editor-switch-caret.ts (the module-level
// switch-caret store); this module owns the VS Code wiring AROUND them — the
// StatusBarController instance, the three per-panel mutable locals
// (lastKnownCaret / lastKnownSelectedChars / wasActive), applyCaretToTextEditor,
// the onDidChangeTextEditorSelection + onDidChangeActiveTextEditor caret
// trackers, the active-edge half of onDidChangeViewState (status-bar show/hide +
// caret-apply), and the switchCaret one-shot restore. It imports vscode
// (mirroring context-handoff-wiring.ts / revert-rescue-wiring.ts) because the
// status-bar drive + TextEditor selection mutation IS this slice's substance.
//
// PURE SIDE CHANNEL vs the reducer: none of this enters the host-session core or
// the write lock, and none mutates the document. The ONE core touch —
// onDidChangeViewState's `viewStateVisible` resync dispatch — is INJECTED
// (dispatchViewStateVisible) so the factory owns the whole handler while the
// reducer dispatch stays the panel's; the webview `caret-apply` post is likewise
// injected (postCaretApply). The three mutable locals are function-scoped (one
// per createCaretHandoffWiring call = one per panel), NEVER module-level — a
// top-level `let` would share caret state across every open document.
//
// The vscode-free pieces stay pinned by status-bar.test.ts / caret-handoff.test.ts
// / editor-switch-caret.test.ts; the end-to-end behaviour by the
// status-bar-active-edge / caret-handoff / two-panel-config-caret /
// toggle-editor-in-place-swap / remember-last-editor-surface e2e, which this only
// re-wires.

import type { TextDocument, TextEditor, WebviewPanel } from "vscode";
import { Position, Range, Selection, window } from "vscode";

import { type Caret, clampCaret } from "./caret-handoff.js";
import {
  createStatusBarController,
  formatLanguageLabel,
  resolveSeedCaret,
  type StatusBarSlots,
} from "./status-bar.js";

export interface CaretHandoffWiringDeps {
  readonly document: TextDocument;
  readonly webviewPanel: WebviewPanel;
  readonly statusBarSlots: StatusBarSlots;
  readonly switchCaret: Caret | null;
  readonly isDisposed: () => boolean;
  readonly postCaretApply: (caret: Caret) => void;
  readonly dispatchViewStateVisible: () => void;
}

export interface CaretHandoffWiring {
  getCaret(): Caret | null;
  applyCaretToTextEditor(editor: TextEditor, caret: Caret): void;
  reportCaret(report: { line: number; character: number; selectedChars: number }): void;
  applySwitchCaretOnReady(): void;
  dispose(): void;
}

export function createCaretHandoffWiring(deps: CaretHandoffWiringDeps): CaretHandoffWiring {
  const { document, webviewPanel, statusBarSlots, switchCaret } = deps;
  const uriString = document.uri.toString();

  // ONE per-panel last-known caret (0-based, VS Code Position convention).
  // Single panel per document, so no Map. Written by BOTH the webview
  // caret-report (Quoll active) and onDidChangeTextEditorSelection (text
  // editor active); applied on the activation edge to whichever surface the
  // user switches INTO. null until the first report — nothing to carry yet.
  let lastKnownCaret: Caret | null = null;
  // Primary-selection character count that rode the last `caret-report`, for
  // the status bar's `(N selected)` readout. 0 = no selection. Tracked
  // alongside lastKnownCaret so the active-edge refresh shows the last live
  // count; reset to 0 by the position-only provenances (text-editor selection,
  // text→Quoll switch) where a Quoll selection is no longer authoritative.
  let lastKnownSelectedChars = 0;
  // Active-edge tracker for the panel. onDidChangeViewState fires on
  // visible/active/focus changes; the caret apply must fire ONCE per
  // inactive→active transition, not on every event. Seeded from the panel's
  // current active state so the first event does not read a false edge.
  let wasActive = webviewPanel.active;
  // One-shot latch for the reverse-switch caret restore (below).
  let switchCaretApplied = false;

  // Status-bar parity (src/extension/status-bar.ts). A custom editor is not a
  // TextEditor, so window.activeTextEditor is undefined and VS Code drops ALL
  // of its built-in status-bar items. This host-owned surface reintroduces the
  // subset whose data already flows here — caret position, EOL, a static
  // language label — shown ONLY while THIS panel is active. Pure additive side
  // channel: no core event/state, no write-lock, no reducer touch; it reuses
  // lastKnownCaret / document.eol. selectedChars: 0 — the seed predates any
  // caret-report, so no selection.
  const statusBar = createStatusBarController(statusBarSlots, {
    view: {
      caret: resolveSeedCaret({ switchCaret, lastKnownCaret }),
      eol: document.eol,
      selectedChars: 0,
    },
    languageLabel: formatLanguageLabel(document.languageId),
  });
  // onDidChangeViewState does not fire for the panel's INITIAL active state,
  // so show once here if it opens active; the edge handler owns it thereafter.
  if (webviewPanel.active) {
    statusBar.show();
  }

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

  // Track the caret while the DEFAULT text editor for this document is the
  // ACTIVE editor, so a text-editor→Quoll switch carries it. Two guards:
  //   - uri match keeps unrelated editors out.
  //   - `window.activeTextEditor === e.textEditor` (Codex #4) ignores a
  //     selection change in a NON-active split / a programmatic selection set
  //     by another extension on the same uri — only the editor the user is
  //     actually in should define the caret to carry.
  // Pure side channel — never the reducer.
  const selectionSub = window.onDidChangeTextEditorSelection((e) => {
    if (deps.isDisposed()) {
      return;
    }
    if (e.textEditor.document.uri.toString() !== uriString) {
      return;
    }
    if (window.activeTextEditor !== e.textEditor) {
      return;
    }
    const active = (e.selections[0] ?? e.textEditor.selection).active;
    lastKnownCaret = { line: active.line, character: active.character };
    // Position-only provenance: the text editor owns its own selection
    // readout, so Quoll's `(N selected)` count is no longer authoritative.
    // Reset so the active-edge refresh does not surface a stale count when
    // the user switches back into Quoll (it re-reports its live selection).
    lastKnownSelectedChars = 0;
  });

  // Quoll→text-editor handoff: when the default text editor for THIS document
  // becomes the active editor, apply lastKnownCaret to it. A custom editor is
  // not a TextEditor, so switching INTO Quoll surfaces here as `undefined`
  // (ignored); switching into the text editor surfaces as a matching-uri
  // editor. Asymmetry is load-bearing — the reverse direction rides
  // onDidChangeViewState below.
  const activeEditorSub = window.onDidChangeActiveTextEditor((editor) => {
    if (deps.isDisposed() || !editor) {
      return;
    }
    if (editor.document.uri.toString() !== uriString) {
      return;
    }
    if (lastKnownCaret === null) {
      return;
    }
    applyCaretToTextEditor(editor, lastKnownCaret);
  });

  // Hidden-webview resync (visible) + caret handoff (active edge).
  //   - Visible: UNCHANGED — when the panel is visible, the core reposts the
  //     current authoritative Document so edits made via the default text
  //     editor (while the rich editor was hidden) land immediately.
  //     Deliberately NOT edge-gated (preserves existing resync semantics).
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
  const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
    if (deps.isDisposed()) {
      return;
    }
    const panel = e.webviewPanel;
    const enteringActive = panel.active && !wasActive;
    wasActive = panel.active;
    // The active-edge caret-apply posted below collapses any selection in
    // the webview (buildCaretApplyMessage carries a single point, and the
    // webview suppresses the echo caret-report), so a stale `(N selected)`
    // would otherwise survive re-activation with no corrective report. Zero
    // the tracked count to match the imminent collapse, before the refresh.
    if (enteringActive && lastKnownCaret !== null) {
      lastKnownSelectedChars = 0;
    }
    // Status-bar parity is bound to the ACTIVE edge (native items track the
    // active editor). Refresh caret + EOL before showing so a change made
    // while inactive is reflected; hide on the inactive edge.
    if (panel.active) {
      statusBar.update({
        caret: lastKnownCaret ?? { line: 0, character: 0 },
        eol: document.eol,
        selectedChars: lastKnownSelectedChars,
      });
      statusBar.show();
    } else {
      statusBar.hide();
    }
    if (panel.visible) {
      deps.dispatchViewStateVisible();
    }
    if (enteringActive && lastKnownCaret !== null) {
      deps.postCaretApply(lastKnownCaret);
    }
  });

  return {
    getCaret(): Caret | null {
      return lastKnownCaret;
    },
    applyCaretToTextEditor,
    reportCaret({ line, character, selectedChars }): void {
      // Self-guard on dispose (mirrors context-handoff-wiring's public arms).
      // Redundant with the panel's top-of-handleInbound guard today, but this
      // is now a public side-effect surface (status-bar update) — a future
      // caller must not drive it post-dispose. No behavioural change: the only
      // current caller (the `caret-report` case) already runs pre-dispose.
      if (deps.isDisposed()) {
        return;
      }
      // Pure side channel: store the webview's latest caret for the
      // Quoll→text-editor handoff. The protocol validator already bounded the
      // coordinates; they are re-clamped at apply time.
      lastKnownCaret = { line, character };
      lastKnownSelectedChars = selectedChars;
      // Live-refresh the status bar caret readout (harmless while hidden —
      // the item is only visible on the active edge). EOL re-read each time
      // so a mid-session EOL change surfaces without its own listener. A
      // non-empty selection appends ` (N selected)`.
      statusBar.update({ caret: lastKnownCaret, eol: document.eol, selectedChars });
    },
    applySwitchCaretOnReady(): void {
      // Self-guard on dispose (mirrors context-handoff-wiring's public arms).
      // Redundant with the panel's top-of-handleInbound guard today, but this
      // is a public side-effect surface (status-bar update + caret-apply post).
      // No behavioural change: the only current caller (the `ready` case) runs
      // pre-dispose.
      if (deps.isDisposed()) {
        return;
      }
      // Reverse switch caret restore. A REVERSE-created panel is fresh (no
      // pending edit, no write-lock), so the ready dispatch posts the seed
      // Document synchronously and this selection-only caret-apply lands
      // AFTER it (FIFO). Pure side channel (no reducer/write-lock). One-shot
      // so a webview reload does not re-fire.
      if (switchCaret === null || switchCaretApplied) {
        return;
      }
      switchCaretApplied = true;
      // The stashed toggle caret is now the last-known caret: keep it in
      // lastKnownCaret so the status bar's active-edge refresh and the reverse
      // Quoll→text handoff read the applied position (the webview suppresses the
      // echo caret-report, so no follow-up report arrives to refresh it).
      lastKnownCaret = switchCaret;
      // The switch places a collapsed caret — no selection to carry.
      lastKnownSelectedChars = 0;
      statusBar.update({ caret: switchCaret, eol: document.eol, selectedChars: 0 });
      deps.postCaretApply(switchCaret);
    },
    dispose(): void {
      // statusBar FIRST — preserves the pre-refactor relative teardown order
      // (the inline `statusBar.dispose()` was `disposables[0]`, torn down
      // before the three caret listeners). Order among these four is in fact
      // behaviourally inert (each is a side-effect-free unsubscribe / item
      // dispose, and every handler is `isDisposed`-guarded), but keeping
      // statusBar first removes any doubt for a behaviour-preserving slice.
      statusBar.dispose();
      selectionSub.dispose();
      activeEditorSub.dispose();
      viewStateSub.dispose();
    },
  };
}
