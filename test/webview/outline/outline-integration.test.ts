// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outlinePlugin } from "../../../src/webview/cm/outline/index.js";
import { type EditorHandle, mountEditor } from "../../../src/webview/editor.js";
import { initialState, type WebviewState } from "../../../src/webview/state.js";

const postMessage = vi.fn();
const postsOfType = (type: string) =>
  postMessage.mock.calls.map((c) => c[0]).filter((m) => (m as { type?: string })?.type === type);

vi.mock("../../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage }),
  subscribeToHost: () => () => {},
  readPersistedState: () => ({}),
  patchPersistedState: () => {},
}));

let container: HTMLElement | null = null;
const mounted: EditorHandle[] = [];

function makeState(overrides: Partial<WebviewState> = {}): WebviewState {
  return { ...initialState, ready: true, docVersion: 1, canWrite: true, ...overrides };
}

beforeEach(() => {
  postMessage.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  // Dispose BEFORE useRealTimers so the caret-report debounce timer is
  // cancelled in the same (fake) timer context it was scheduled in.
  for (const handle of mounted.splice(0)) {
    handle.dispose();
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("outline navigation integration", () => {
  it("posts a caret-report but never an Edit when a heading is clicked", () => {
    vi.useFakeTimers();
    const state = makeState();
    const handle = mountEditor({
      parent: container as HTMLElement,
      nonce: "test-nonce",
      getState: () => state,
      dispatch: () => {},
    });
    mounted.push(handle);
    handle.applyDocument("# Alpha\n\n## Beta\n", true, 1);

    const mountEl = container?.querySelector(".quoll-editor") as HTMLElement;
    const view = EditorView.findFromDOM(mountEl) as EditorView;
    view.plugin(outlinePlugin)?.toggle(); // immediate rebuild — buttons now exist

    postMessage.mockClear(); // ignore any seed-time traffic
    const items = mountEl.querySelectorAll<HTMLButtonElement>(".quoll-outline-item");
    items[1].click(); // "Beta"
    vi.advanceTimersByTime(100); // caret-report is debounced (~100ms trailing)

    expect(postsOfType("edit")).toEqual([]); // byte-preserving: no write
    expect(postsOfType("caret-report").length).toBeGreaterThan(0); // selection moved
    expect(view.state.sliceDoc()).toBe("# Alpha\n\n## Beta\n"); // doc unchanged
  });
});
