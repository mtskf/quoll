// @vitest-environment happy-dom

import { insertNewline } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostDocumentReseed } from "../../src/webview/cm/host-reseed.js";
import { matchesSwitchEditorChord, quollSwitchEditor } from "../../src/webview/cm/switch-editor.js";
import { type EditorHandle, mountEditor } from "../../src/webview/editor.js";
import { initialState } from "../../src/webview/state.js";

const postMessage = vi.fn();
vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage }),
  readPersistedState: () => ({}),
  patchPersistedState: () => {},
}));

let view: EditorView | null = null;
let editor: EditorHandle | null = null;

afterEach(() => {
  if (editor) {
    editor.dispose();
    editor = null;
  } else {
    view?.destroy();
  }
  view = null;
  document.body.textContent = "";
  vi.useRealTimers();
  postMessage.mockReset();
});

describe("switch edit lock", () => {
  function mountRealEditor(): { handle: EditorHandle; view: EditorView } {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const handle = mountEditor({
      parent,
      nonce: "test",
      getState: () => ({ ...initialState, ready: true, canWrite: true, docVersion: 1 }),
      dispatch: () => {},
    });
    editor = handle;
    const mountedView = EditorView.findFromDOM(
      parent.querySelector(".quoll-editor") as HTMLElement
    );
    if (!mountedView) {
      throw new Error("EditorView not found");
    }
    view = mountedView;
    handle.applyDocument({
      content: "seed",
      eol: "\n",
      canWrite: true,
      docVersion: 1,
      externalEpoch: 0,
      epochGeneration: 1,
      settledEditId: 0,
    });
    return { handle, view: mountedView };
  }

  const switchPosts = () => postMessage.mock.calls.filter(([m]) => m.type === "switch-to-text");

  it("blocks raw document changes after posting", async () => {
    const mounted = mountRealEditor();
    await mounted.handle.requestSwitch();
    expect(switchPosts()).toHaveLength(1);
    mounted.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    expect(mounted.view.state.doc.toString()).toBe("seed");
  });

  it("blocks editing commands after posting", async () => {
    const mounted = mountRealEditor();
    await mounted.handle.requestSwitch();
    insertNewline(mounted.view);
    expect(mounted.view.state.doc.toString()).toBe("seed");
  });

  it("allows selection and host reseeds while ignoring another request", async () => {
    const mounted = mountRealEditor();
    await mounted.handle.requestSwitch();
    mounted.view.dispatch({ selection: { anchor: 2 } });
    expect(mounted.view.state.selection.main.head).toBe(2);
    mounted.view.dispatch({
      changes: { from: 0, to: 4, insert: "host" },
      annotations: hostDocumentReseed.of(true),
    });
    expect(mounted.view.state.doc.toString()).toBe("host");
    await mounted.handle.requestSwitch();
    expect(switchPosts()).toHaveLength(1);
  });

  it("does not post when disposed during settlement", async () => {
    vi.useFakeTimers();
    const mounted = mountRealEditor();
    mounted.view.dispatch({ changes: { from: 4, insert: "x" } });
    const pending = mounted.handle.requestSwitch();
    mounted.handle.dispose();
    editor = null;
    view = null;
    await pending;
    expect(switchPosts()).toHaveLength(0);
  });
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
