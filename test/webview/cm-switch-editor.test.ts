// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../../src/shared/protocol.js";
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

const EXPECTED = { protocol: PROTOCOL_VERSION, type: "switch-to-text" };

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
  it("posts switch-to-text for the macOS dead-key ⌘⌥E keydown (reproduces + fixes the regression)", () => {
    const postMessage = vi.fn();
    mount([quollSwitchEditor({ postMessage }, () => {})]);
    dispatchKeydown({ key: "Dead", code: "KeyE", metaKey: true, altKey: true });
    expect(postMessage).toHaveBeenCalledWith(EXPECTED);
  });

  it("flushes pending edits before posting (no data loss on type-then-switch)", () => {
    const calls: string[] = [];
    const flush = vi.fn(() => calls.push("flush"));
    const postMessage = vi.fn(() => calls.push("post"));
    mount([quollSwitchEditor({ postMessage }, flush)]);
    dispatchKeydown({ key: "Dead", code: "KeyE", metaKey: true, altKey: true });
    expect(calls).toEqual(["flush", "post"]);
  });

  it("does not throw out of the keydown handler when postMessage throws", () => {
    const postMessage = vi.fn(() => {
      throw new Error("transport gone");
    });
    mount([quollSwitchEditor({ postMessage }, () => {})]);
    expect(() =>
      dispatchKeydown({ key: "Dead", code: "KeyE", metaKey: true, altKey: true })
    ).not.toThrow();
  });

  it("ignores a non-chord keydown", () => {
    const postMessage = vi.fn();
    mount([quollSwitchEditor({ postMessage }, () => {})]);
    dispatchKeydown({ key: "a", code: "KeyA" });
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("quollSwitchEditor button", () => {
  it("renders a top-right toggle button inside the .quoll-editor host", () => {
    const postMessage = vi.fn();
    const host = mount([quollSwitchEditor({ postMessage }, () => {})]);
    expect(host.querySelector(".quoll-switch-editor-toggle")).not.toBeNull();
  });

  it("posts switch-to-text when the button is clicked", () => {
    const postMessage = vi.fn();
    const host = mount([quollSwitchEditor({ postMessage }, () => {})]);
    host.querySelector<HTMLButtonElement>(".quoll-switch-editor-toggle")?.click();
    expect(postMessage).toHaveBeenCalledWith(EXPECTED);
  });
});
