// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../../src/shared/protocol.js";
import {
  quollSwitchEditor,
  SWITCH_EDITOR_KEY,
  switchToTextCommand,
} from "../../src/webview/cm/switch-editor.js";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = "";
});

function mount(extensions: Extension[]): HTMLElement {
  const host = document.createElement("div");
  host.className = "quoll-editor";
  document.body.appendChild(host);
  view = new EditorView({ parent: host, state: EditorState.create({ doc: "x", extensions }) });
  return host;
}

const EXPECTED = { protocol: PROTOCOL_VERSION, type: "switch-to-text" };

describe("SWITCH_EDITOR_KEY", () => {
  it("is the Ctrl/Cmd+Alt+E chord (kept in sync with package.json's reverse binding)", () => {
    expect(SWITCH_EDITOR_KEY).toBe("Mod-Alt-e");
  });
});

describe("switchToTextCommand", () => {
  it("posts a switch-to-text message and claims the chord", () => {
    const postMessage = vi.fn();
    mount([]);
    const handled = switchToTextCommand({ postMessage })(view as EditorView);
    expect(handled).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(EXPECTED);
  });

  it("returns true even when postMessage throws (chord is claimed)", () => {
    const postMessage = vi.fn(() => {
      throw new Error("transport gone");
    });
    mount([]);
    expect(switchToTextCommand({ postMessage })(view as EditorView)).toBe(true);
  });
});

describe("quollSwitchEditor button", () => {
  it("renders a top-right toggle button inside the .quoll-editor host", () => {
    const postMessage = vi.fn();
    const host = mount([quollSwitchEditor({ postMessage })]);
    expect(host.querySelector(".quoll-switch-editor-toggle")).not.toBeNull();
  });

  it("posts switch-to-text when the button is clicked", () => {
    const postMessage = vi.fn();
    const host = mount([quollSwitchEditor({ postMessage })]);
    host.querySelector<HTMLButtonElement>(".quoll-switch-editor-toggle")?.click();
    expect(postMessage).toHaveBeenCalledWith(EXPECTED);
  });
});
