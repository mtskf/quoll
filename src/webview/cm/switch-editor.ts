// Quoll → plain text editor switch. A webview-native affordance mirroring the
// document-outline overlay: a top-RIGHT overlay button + a Prec.high CM keymap,
// both posting the envelope-only `switch-to-text` side-channel message. The host
// reopens the document in VS Code's built-in text editor (vscode.openWith …
// "default") and re-applies the caret.
//
// The chord lives HERE (a CodeMirror keymap), not in package.json
// contributes.keybindings, so it fires reliably while the Quoll webview holds
// focus — same rationale as the context-handoff / outline chords (a focused
// webview iframe captures keydown; a CM keymap is the reliable in-focus path).
// package.json binds the SAME chord to `quoll.toggleEditor` ONLY in the
// text-editor context (the reverse direction) — deliberately NOT in the
// custom-editor context, which would double-fire with this keymap and bounce.
//
// Pure side channel: NEVER dispatches a CodeMirror change, NEVER enters the host
// write-lock. The caret survives via the host handler; this module adds no caret
// code.

import { type Extension, Prec } from "@codemirror/state";
import { type Command, type EditorView, keymap, type PluginValue, ViewPlugin } from "@codemirror/view";

import { buildSwitchToTextMessage, type WebviewToHost } from "../../shared/protocol.js";

export type SwitchEditorHost = { postMessage(message: WebviewToHost): void };

/** The chord string. Single source of truth for the CM keymap; pinned by a unit
 *  test. Mod = Cmd (mac) / Ctrl (win+linux); Alt = Option (mac). Kept in sync
 *  with the `ctrl+alt+e` / `cmd+alt+e` reverse entry in package.json. */
export const SWITCH_EDITOR_KEY = "Mod-Alt-e";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build the Lucide `file-pen-line` (MIT) icon as an SVG DOM subtree —
 *  createElementNS, never innerHTML (the src/** no-innerHTML invariant, enforced
 *  by test/markdown/url-choke-point.test.ts). stroke=currentColor tracks
 *  --vscode-icon-foreground via the button's `color`. */
function createFilePenLineIcon(): SVGSVGElement {
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
    "M14.364 13.634a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506l4.013-4.009a1 1 0 0 0-3.004-3.004z",
    "M14.487 7.858A1 1 0 0 1 14 7V2",
    "M20 19.645V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l2.516 2.516",
    "M8 18h1",
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
function postSwitchToText(host: SwitchEditorHost): void {
  try {
    host.postMessage(buildSwitchToTextMessage());
  } catch (err) {
    console.error("[quoll] postMessage(switch-to-text) failed", err);
  }
}

/** The chord command. Exported so the keymap test can invoke it directly on a
 *  real EditorView (avoids a platform-flaky synthetic key event — see
 *  [[quoll-cm-keymap-test-runscopehandlers-platform-flaky]]). */
export function switchToTextCommand(host: SwitchEditorHost): Command {
  return () => {
    postSwitchToText(host);
    // Claim the chord regardless so CodeMirror preventDefaults it.
    return true;
  };
}

class SwitchEditorButton implements PluginValue {
  private readonly hostEl: HTMLElement;
  private readonly buttonEl: HTMLButtonElement;

  constructor(
    view: EditorView,
    private readonly messageHost: SwitchEditorHost
  ) {
    // Mounted inside the `.quoll-editor` host (position:relative) so the button
    // overlays the surface without reflowing the reading column — identical
    // contract to the outline toggle. Fail fast otherwise.
    const hostEl = view.dom.closest(".quoll-editor");
    if (!(hostEl instanceof HTMLElement)) {
      throw new Error("quollSwitchEditor: EditorView must be mounted inside a .quoll-editor host");
    }
    this.hostEl = hostEl;

    this.buttonEl = document.createElement("button");
    this.buttonEl.type = "button";
    this.buttonEl.className = "quoll-switch-editor-toggle";
    this.buttonEl.title = "Open in text editor (Ctrl/Cmd+Alt+E)";
    this.buttonEl.setAttribute("aria-label", "Open in text editor");
    this.buttonEl.appendChild(createFilePenLineIcon());
    // preventDefault on mousedown so clicking does not blur/move the selection
    // before we act (mirrors the outline toggle).
    this.buttonEl.addEventListener("mousedown", (e) => e.preventDefault());
    this.buttonEl.addEventListener("click", (e) => {
      e.preventDefault();
      postSwitchToText(this.messageHost);
    });
    this.hostEl.appendChild(this.buttonEl);
  }

  destroy(): void {
    this.buttonEl.remove();
  }
}

/** The switch-editor extension: the top-right overlay button + the chord keymap,
 *  both posting `switch-to-text`. */
export function quollSwitchEditor(host: SwitchEditorHost): Extension {
  const plugin = ViewPlugin.define((view) => new SwitchEditorButton(view, host));
  const km = Prec.high(keymap.of([{ key: SWITCH_EDITOR_KEY, run: switchToTextCommand(host) }]));
  return [plugin, km];
}
