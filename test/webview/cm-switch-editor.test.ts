// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { matchesSwitchEditorChord, quollSwitchEditor } from "../../src/webview/cm/switch-editor.js";

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

function dispatchKeydown(init: KeyboardEventInit): void {
  (view as EditorView).contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  );
}

describe("matchesSwitchEditorChord", () => {
  // The regression this pins: on macOS Option+E is the acute-accent DEAD KEY, so a
  // ⌘⌥E keydown arrives with `event.key === "Dead"` (or "´") and keyCode 229 — a
  // `Mod-Alt-e` CodeMirror keymap (matched via event.key/keyCode) can NEVER match
  // it. Matching the PHYSICAL `event.code` ("KeyE") recognizes it and mirrors VS
  // Code's reverse `cmd+alt+e` binding. keyCode is irrelevant to the predicate
  // (and not settable via KeyboardEventInit), so `key: "Dead"` carries the repro.
  it("matches the macOS dead-key ⌘⌥E keydown (key:Dead)", () => {
    expect(
      matchesSwitchEditorChord(
        new KeyboardEvent("keydown", { key: "Dead", code: "KeyE", metaKey: true, altKey: true })
      )
    ).toBe(true);
  });

  it("matches the macOS composed-accent ⌘⌥´ keydown (key:´)", () => {
    expect(
      matchesSwitchEditorChord(
        new KeyboardEvent("keydown", { key: "´", code: "KeyE", metaKey: true, altKey: true })
      )
    ).toBe(true);
  });

  it("matches Ctrl+Alt+E (win/linux reverse-binding parity)", () => {
    expect(
      matchesSwitchEditorChord(
        new KeyboardEvent("keydown", { key: "e", code: "KeyE", ctrlKey: true, altKey: true })
      )
    ).toBe(true);
  });

  it.each([
    ["plain Alt+E — typing é, no Mod", { key: "´", code: "KeyE", altKey: true }],
    ["Cmd+E without Alt", { key: "e", code: "KeyE", metaKey: true }],
    ["Cmd+Alt+K — different physical key", { key: "k", code: "KeyK", metaKey: true, altKey: true }],
    ["Shift+Cmd+Alt+E", { key: "Dead", code: "KeyE", metaKey: true, altKey: true, shiftKey: true }],
  ])("does not match %s", (_name, init) => {
    expect(matchesSwitchEditorChord(new KeyboardEvent("keydown", init))).toBe(false);
  });
});

describe("quollSwitchEditor chord (keydown)", () => {
  it("requests a switch for the macOS dead-key chord", () => {
    const requestSwitch = vi.fn(async () => {});
    mount([quollSwitchEditor(requestSwitch)]);
    dispatchKeydown({ key: "Dead", code: "KeyE", metaKey: true, altKey: true });
    expect(requestSwitch).toHaveBeenCalledOnce();
  });

  it("ignores a non-chord keydown", () => {
    const requestSwitch = vi.fn(async () => {});
    mount([quollSwitchEditor(requestSwitch)]);
    dispatchKeydown({ key: "a", code: "KeyA" });
    expect(requestSwitch).not.toHaveBeenCalled();
  });
});

describe("quollSwitchEditor button", () => {
  it("renders a toggle and requests a switch when clicked", () => {
    const requestSwitch = vi.fn(async () => {});
    const host = mount([quollSwitchEditor(requestSwitch)]);
    const button = host.querySelector<HTMLButtonElement>(".quoll-switch-editor-toggle");
    expect(button).not.toBeNull();
    button?.click();
    expect(requestSwitch).toHaveBeenCalledOnce();
  });
});
