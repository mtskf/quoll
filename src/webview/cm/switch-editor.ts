// Quoll → plain text editor switch. A webview-native affordance mirroring the
// document-outline overlay: a top-RIGHT overlay button + a Prec.high keydown
// handler, both posting the envelope-only `switch-to-text` side-channel message.
// The host reopens the document in VS Code's built-in text editor (vscode.openWith
// … "default") and re-applies the caret.
//
// The chord lives HERE (a CodeMirror keydown handler), not in package.json
// contributes.keybindings, so it fires reliably while the Quoll webview holds
// focus — same rationale as the context-handoff / outline chords (a focused
// webview iframe captures keydown; an in-webview handler is the reliable in-focus
// path). package.json binds the SAME chord to `quoll.toggleEditor` ONLY in the
// text-editor context (the reverse direction) — deliberately NOT in the
// custom-editor context, which would double-fire with this handler and bounce.
//
// Why a raw keydown handler keyed on `event.code`, NOT a `Mod-Alt-e` CM keymap:
// on macOS, Option+E is the acute-accent DEAD KEY, so a ⌘⌥E keydown arrives with
// `event.key === "Dead"` (or "´") and `event.keyCode === 229`. A CodeMirror
// keymap matches via `event.key`/`event.keyCode` (w3c-keyname), which can NEVER
// match those dead-key values — that was the Quoll→text regression (the reverse
// direction and the button were unaffected). `event.code` is the layout-
// independent PHYSICAL key ("KeyE") and is exactly what VS Code's reverse
// `cmd+alt+e` binding matches, so both directions stay symmetric. See
// matchesSwitchEditorChord.
//
// Pure side channel: NEVER dispatches a CodeMirror change, NEVER enters the host
// write-lock. The caret survives via the host handler; this module adds no caret
// code.

import { type Extension, Prec } from "@codemirror/state";
import { EditorView, type PluginValue, ViewPlugin } from "@codemirror/view";

import { buildSwitchToTextMessage } from "../../shared/protocol.js";
import { type PostMessageHost, safePostMessage } from "../safe-post-message.js";
import { requireQuollEditorHost } from "./editor-host.js";

export type SwitchEditorHost = PostMessageHost;

/** Match the Quoll→text switch chord: Ctrl/Cmd + Alt + E, keyed on the PHYSICAL
 *  `event.code` ("KeyE") — NOT `event.key`. On macOS Option+E is the acute-accent
 *  dead key, so a ⌘⌥E keydown arrives with `event.key === "Dead"`/"´" and
 *  `event.keyCode === 229`; matching `event.code` sidesteps that entirely and
 *  mirrors VS Code's reverse `cmd+alt+e` binding (see the module header).
 *  Mod = Cmd (mac) / Ctrl (win+linux) — accept either metaKey or ctrlKey so we
 *  need no platform detection (and stay test-deterministic). Shift excluded to
 *  pin the exact combo. On Windows this also matches AltGr (= Ctrl+Alt), an
 *  accepted trade-off: it is identical to VS Code's reverse `ctrl+alt+e` binding,
 *  so it introduces no behaviour the reverse direction doesn't already have. Kept
 *  in sync with the `ctrl+alt+e` / `cmd+alt+e` reverse entry in package.json. */
export function matchesSwitchEditorChord(event: KeyboardEvent): boolean {
  return (
    event.code === "KeyE" && event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build the Lucide `file-code` (MIT) icon as an SVG DOM subtree —
 *  createElementNS, never innerHTML (the src/** no-innerHTML invariant, enforced
 *  by test/markdown/url-choke-point.test.ts). stroke=currentColor tracks
 *  --vscode-icon-foreground via the button's `color`. */
function createFileCodeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const paths = [
    "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 12.5 8 15l2 2.5",
    "m14 12.5 2 2.5-2 2.5",
  ];
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Post `switch-to-text`, logging (never throwing) on transport failure — a
 *  throw out of a click handler / keymap command would unwind the caller. */
function postSwitchToText(host: SwitchEditorHost, flushPendingEdit: () => void): void {
  // Flush any pending debounced edit FIRST: the switch disposes this panel,
  // so a late debounced Edit would be dropped post-dispose (data loss). FIFO
  // — the flushed Edit reaches the host before switch-to-text, so the
  // reopened text editor shows the just-typed content.
  try {
    flushPendingEdit();
  } catch (err) {
    console.error("[quoll] flushPendingEdit before switch failed", err);
  }
  safePostMessage(host, buildSwitchToTextMessage(), "switch-to-text");
}

class SwitchEditorButton implements PluginValue {
  private readonly hostEl: HTMLElement;
  private readonly buttonEl: HTMLButtonElement;

  constructor(
    view: EditorView,
    private readonly messageHost: SwitchEditorHost,
    private readonly flushPendingEdit: () => void
  ) {
    // Mounted inside the `.quoll-editor` host (position:relative) so the button
    // overlays the surface without reflowing the reading column — identical
    // contract to the outline toggle. Fail fast otherwise.
    const hostEl = requireQuollEditorHost(view, "quollSwitchEditor");
    this.hostEl = hostEl;

    this.buttonEl = document.createElement("button");
    this.buttonEl.type = "button";
    this.buttonEl.className = "quoll-switch-editor-toggle";
    this.buttonEl.title = "Open in text editor (⌘⌥E / Ctrl+Alt+E)";
    this.buttonEl.setAttribute("aria-label", "Open in text editor");
    this.buttonEl.appendChild(createFileCodeIcon());
    // preventDefault on mousedown so clicking does not blur/move the selection
    // before we act (mirrors the outline toggle).
    this.buttonEl.addEventListener("mousedown", (e) => e.preventDefault());
    this.buttonEl.addEventListener("click", (e) => {
      e.preventDefault();
      postSwitchToText(this.messageHost, this.flushPendingEdit);
    });
    this.hostEl.appendChild(this.buttonEl);
  }

  destroy(): void {
    this.buttonEl.remove();
  }
}

/** The switch-editor extension: the top-right overlay button + the chord keydown
 *  handler, both posting `switch-to-text`. */
export function quollSwitchEditor(host: SwitchEditorHost, flushPendingEdit: () => void): Extension {
  const plugin = ViewPlugin.define((view) => new SwitchEditorButton(view, host, flushPendingEdit));
  // A raw keydown handler (NOT a keymap) so the chord matches on the PHYSICAL
  // `event.code` — see matchesSwitchEditorChord for the macOS Option+E dead-key
  // rationale. Prec.high so it claims ⌘⌥E before lower-precedence handlers;
  // returning true makes CodeMirror preventDefault() the keydown. The panel
  // switches (disposes) immediately, so any dead-key accent composition is moot.
  const chord = Prec.high(
    EditorView.domEventHandlers({
      keydown(event) {
        if (!matchesSwitchEditorChord(event)) {
          return false;
        }
        postSwitchToText(host, flushPendingEdit);
        return true;
      },
    })
  );
  return [plugin, chord];
}
