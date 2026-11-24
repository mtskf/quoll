// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_LENGTH } from "../../src/shared/protocol.js";
import { type EditorHandle, mountEditor } from "../../src/webview/editor.js";
import { type Action, initialState, reducer } from "../../src/webview/state.js";

const postMessage = vi.fn();
vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage }),
  subscribeToHost: () => () => {},
  readPersistedState: () => ({}),
  patchPersistedState: () => {},
}));
const seed = {
  content: "seed",
  eol: "\n" as const,
  canWrite: true,
  docVersion: 1,
  externalEpoch: 0,
  epochGeneration: 1,
  settledEditId: 0,
};
let container: HTMLElement;
let handle: EditorHandle | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  postMessage.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.body.appendChild(document.createElement("div"));
});
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function mount() {
  let state = initialState;
  const commits: Action[] = [];
  const posted: string[] = [];
  let fail = false;
  postMessage.mockImplementation((message: { type: string; content: string }) => {
    if (message.type !== "edit") {
      return;
    }
    if (fail) {
      throw new Error("transport failed");
    }
    posted.push(message.content);
  });
  const dispatch = (action: Action) => {
    const next = reducer(state, action);
    if (next === state) {
      return;
    }
    state = next;
    commits.push(action);
    handle?.onReducerCommit(state.editInFlight);
  };
  const editor = mountEditor({ parent: container, nonce: "test", getState: () => state, dispatch });
  handle = editor;
  const document = (snapshot: typeof seed) => {
    const result = editor.applyDocument(snapshot);
    dispatch({
      type: "document",
      docVersion: snapshot.docVersion,
      canWrite: snapshot.canWrite,
      themeKind: "dark",
      editPending: result,
    });
  };
  document(seed);
  const view = EditorView.findFromDOM(container.querySelector(".quoll-editor") as HTMLElement)!;
  return {
    editor,
    posted,
    commits,
    document,
    state: () => state,
    fail: (value: boolean) => {
      fail = value;
    },
    type: (content: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    },
  };
}
describe("editor — failed sends preserve receipt ownership", () => {
  it("idle transport failure never commits post-edit and the next keystroke sends", () => {
    const s = mount();
    s.fail(true);
    s.type("a");
    vi.advanceTimersByTime(300);
    expect(s.state().editInFlight).toBe(false);
    expect.soft(s.commits.filter((a) => a.type === "post-edit")).toEqual([]);
    s.fail(false);
    s.type("ab");
    vi.advanceTimersByTime(300);
    expect(s.posted.at(-1)).toBe("ab");
    expect(s.state().editInFlight).toBe(true);
  });

  it.each([
    "size cap",
    "transport throw",
  ])("keeps Edit 1 in flight after a forced %s failure", (fault) => {
    const s = mount();
    s.type("a");
    vi.advanceTimersByTime(300);
    expect(s.posted).toEqual(["a"]);
    s.fail(fault === "transport throw");
    s.type(fault === "size cap" ? "x".repeat(MAX_CONTENT_LENGTH + 1) : "ab");
    s.editor.flushPending();
    expect(s.state().sendFailure).not.toBeNull();
    expect.soft(s.state().editInFlight).toBe(true);
    s.fail(false);
    s.type("abc");
    vi.advanceTimersByTime(300);
    expect.soft(s.posted).toEqual(["a"]);
    s.document({ ...seed, docVersion: 2, content: "a", settledEditId: 1 });
    expect(s.posted.at(-1)).toBe("abc");
  });

  it("replays a failed force-post's retained bytes on Edit 1's covering ack without retyping", () => {
    const s = mount();
    s.type("a");
    vi.advanceTimersByTime(300);
    expect(s.posted).toEqual(["a"]);
    s.fail(true);
    s.type("ab");
    s.editor.flushPending();
    expect(s.state().sendFailure).not.toBeNull();
    s.fail(false);
    s.document({ ...seed, docVersion: 2, content: "a", settledEditId: 1 });
    expect(s.state().sendFailure).toBeNull();
    expect(s.posted).toEqual(["a", "ab"]);
    expect(s.state().editInFlight).toBe(true);
  });
});
