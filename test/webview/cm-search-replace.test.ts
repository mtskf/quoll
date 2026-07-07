// @vitest-environment happy-dom
import { openSearchPanel, replaceAll, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.js";
import { type EditorHandle, mountEditor } from "../../src/webview/editor.js";
import { initialState, type WebviewState } from "../../src/webview/state.js";

// Capture host postMessage so we can assert replace posts a normal `edit`
// (and that a read-only replace posts nothing).
const posted: unknown[] = [];
vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage: (m: unknown) => posted.push(m) }),
  subscribeToHost: () => () => {},
}));

type EditMsg = { protocol: number; type: string; content: string; baseDocVersion: number };
const isEdit = (m: unknown): m is EditMsg =>
  typeof m === "object" && m !== null && (m as { type?: string }).type === "edit";

// Track every mounted editor and dispose in afterEach — dispose() cancels the
// pending debounce flush so a live updateListener/timer never leaks into the
// next test (mirrors test/webview/editor.test.ts). Real timers throughout
// (the debounce test awaits a real 350ms), so no fake-timer teardown ordering.
const mounted: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const { handle, parent } of mounted.splice(0)) {
    handle.dispose();
    parent.remove();
  }
});

function mount(doc: string, canWrite: boolean) {
  posted.length = 0;
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state: WebviewState = { ...initialState, canWrite };
  const handle = mountEditor({
    parent,
    nonce: "test-nonce",
    getState: () => state,
    dispatch: () => {},
  });
  mounted.push({ handle, parent });
  // Arm edit-sync with a host snapshot at v1 (same as a real seed).
  handle.applyDocument(doc, canWrite, 1);
  const view = EditorView.findFromDOM(
    parent.querySelector(".cm-editor") as HTMLElement
  ) as EditorView;
  return { handle, view, parent };
}

describe("in-editor find & replace", () => {
  it("openSearchPanel mounts the panel in the TOP container (pins search({ top: true }) is wired)", () => {
    // Non-vacuous: openSearchPanel auto-injects a DEFAULT (bottom) search config
    // if search() is absent, so a bare `.cm-panel.cm-search` would mount even
    // unwired. Asserting the panel is inside `.cm-panels-top` pins OUR
    // search({ top: true }) wiring — unwired, the panel lands in .cm-panels-bottom.
    const { view } = mount("foo foo", true);
    openSearchPanel(view);
    expect(view.dom.querySelector(".cm-panels-top .cm-panel.cm-search")).not.toBeNull();
  });

  it("replace-all posts the replaced content as a normal Edit via the 300ms debounce path", async () => {
    const { view } = mount("foo foo", true);
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "foo", replace: "bar" })),
    });
    expect(replaceAll(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe("bar bar");
    // NOT a bypass write: nothing is posted synchronously — edit-sync debounces.
    expect(posted.filter(isEdit)).toHaveLength(0);
    // Let the real 300ms debounce fire (the normal keystroke post path).
    await new Promise((r) => setTimeout(r, 350));
    const edits = posted.filter(isEdit);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "bar bar",
      baseDocVersion: 1,
    });
  });

  it("replace is a no-op in read-only mode (doc unchanged, nothing posted)", () => {
    const { handle, view } = mount("foo foo", false);
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "foo", replace: "bar" })),
    });
    // CM's replaceAll guards on state.readOnly (EditorState.readOnly.of(true)
    // when canWrite=false), so it returns false and mutates nothing.
    expect(replaceAll(view)).toBe(false);
    expect(view.state.sliceDoc()).toBe("foo foo");
    handle.flushPending();
    expect(posted.filter(isEdit)).toHaveLength(0);
  });
});
