// @vitest-environment happy-dom
import { StateEffect } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.js";
import { type EditorHandle, mountEditor } from "../../src/webview/editor.js";
import { type Action, initialState, type WebviewState } from "../../src/webview/state.js";

// SYNC-01: CodeMirror commits the new state BEFORE it touches the DOM, and runs
// each update listener inside its own try/catch. So a throw from the DOM phase
// skips every listener, and a throw from inside the edit-sync listener is logged
// and swallowed — either way the committed edit is in `view.state` but nothing
// schedules it, and the user gets no sign it never reached the host. These pin
// the contract for any dispatch: the edit is scheduled, or it is surfaced.

const postMessage = vi.fn();
const editPosts = () =>
  postMessage.mock.calls
    .map((c) => c[0] as { type?: string; content?: string })
    .filter((m) => m?.type === "edit");

vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage }),
  subscribeToHost: () => () => {},
  readPersistedState: () => ({}),
  patchPersistedState: () => {},
}));

// Fault-injection seam for the listener arm: wraps the real edit-sync so one
// `onLocalChange` call can be made to throw.
const syncFault = { throwOnLocalChange: false };
vi.mock("../../src/webview/cm/edit-sync.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/webview/cm/edit-sync.js")>();
  return {
    ...real,
    createEditSync: (...args: Parameters<typeof real.createEditSync>) => {
      const sync = real.createEditSync(...args);
      return {
        ...sync,
        onLocalChange: () => {
          if (syncFault.throwOnLocalChange) {
            syncFault.throwOnLocalChange = false;
            throw new Error("onLocalChange exploded");
          }
          sync.onLocalChange();
        },
      };
    },
  };
});

const SNAPSHOT = {
  content: "seed",
  eol: "\n" as const,
  canWrite: true,
  docVersion: 1,
  externalEpoch: 0,
  epochGeneration: 1,
  settledEditId: 0,
};

let container: HTMLElement;
const mounted: EditorHandle[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  postMessage.mockReset();
  syncFault.throwOnLocalChange = false;
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  for (const handle of mounted.splice(0)) {
    handle.dispose();
  }
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount() {
  let state: WebviewState = { ...initialState, ready: true, docVersion: 1, canWrite: true };
  const actions: Action[] = [];
  const handle = mountEditor({
    parent: container,
    nonce: "test-nonce",
    getState: () => state,
    dispatch: (action) => {
      actions.push(action);
      if (action.type === "send-failure") {
        state = { ...state, sendFailure: action.message };
      } else if (action.type === "local-edit-attempt") {
        state = { ...state, sendFailure: null };
      }
    },
  });
  mounted.push(handle);
  handle.applyDocument(SNAPSHOT);
  const view = EditorView.findFromDOM(container.querySelector(".quoll-editor") as HTMLElement);
  if (!view) {
    throw new Error("EditorView not found via findFromDOM");
  }
  // A host Document as the shell delivers it: applyDocument, then the reducer's
  // `document` arm (which clears the send-failure gate), then the drain.
  const hostDocument = (snapshot: typeof SNAPSHOT) => {
    handle.applyDocument(snapshot);
    state = { ...state, docVersion: snapshot.docVersion, sendFailure: null };
    handle.onReducerCommit(false);
  };
  return { handle, view, actions, hostDocument };
}

// A widget whose DOM build throws: CodeMirror calls toDOM unwrapped inside its
// DOM update, after the state is already committed.
class ExplodingWidget extends WidgetType {
  toDOM(): HTMLElement {
    throw new Error("toDOM exploded");
  }
}

describe("editor — a committed edit is never silently unsent (SYNC-01)", () => {
  it("still schedules the edit when the DOM update throws", () => {
    const { view } = mount();
    let explode = false;
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.decorations.of(() =>
          explode
            ? Decoration.set(Decoration.widget({ widget: new ExplodingWidget() }).range(0))
            : Decoration.none
        )
      ),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    explode = true;
    expect(() => view.dispatch({ changes: { from: 4, insert: "x" } })).toThrow("toDOM exploded");
    explode = false;
    // The state was committed before the throw…
    expect(view.state.doc.toString()).toBe("seedx");
    vi.advanceTimersByTime(300);
    // …and those bytes go out on the normal debounce.
    expect(editPosts()).toEqual([
      expect.objectContaining({ protocol: PROTOCOL_VERSION, type: "edit", content: "seedx" }),
    ]);
  });

  it("surfaces the edit as unsent when edit-sync's scheduling throws, and the next keystroke retries", () => {
    const { view, actions } = mount();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    syncFault.throwOnLocalChange = true;
    view.dispatch({ changes: { from: 4, insert: "x" } });
    vi.advanceTimersByTime(300);
    expect(editPosts()).toEqual([]);
    const failure = actions.find((a) => a.type === "send-failure");
    expect(failure).toEqual({
      type: "send-failure",
      message: expect.stringContaining("onLocalChange exploded"),
    });
    expect(
      consoleSpy.mock.calls.some(
        ([first]) => typeof first === "string" && first.startsWith("[quoll]")
      )
    ).toBe(true);
    // The retry contract of every send failure: the next keystroke clears the
    // gate and ships the WHOLE document, the unsent change included.
    view.dispatch({ changes: { from: 5, insert: "y" } });
    vi.advanceTimersByTime(300);
    expect(editPosts().map((m) => m.content)).toEqual(["seedxy"]);
  });

  it("keeps the unscheduled edit when a same-lineage Document arrives before the next keystroke, and posts it", () => {
    const { view, hostDocument } = mount();
    vi.spyOn(console, "error").mockImplementation(() => {});
    syncFault.throwOnLocalChange = true;
    view.dispatch({ changes: { from: 4, insert: "x" } });
    vi.advanceTimersByTime(300);
    expect(editPosts()).toEqual([]);
    // Same epoch and generation, a newer version, the host's old bytes: a
    // Document of the lineage the unsent change was typed on. Its reducer arm
    // clears the banner, so a reseed here would lose the edit unseen.
    hostDocument({ ...SNAPSHOT, docVersion: 2 });
    expect(view.state.doc.toString()).toBe("seedx");
    expect(editPosts().map((m) => m.content)).toEqual(["seedx"]);
  });

  it("does not retain an unscheduled programmatic edit while read-only, so write access returning cannot post it", () => {
    const { view, hostDocument } = mount();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Read-only, same lineage. Programmatic dispatch is not stopped by the
    // readOnly facet, so a change can still be committed here.
    hostDocument({ ...SNAPSHOT, docVersion: 2, canWrite: false });
    syncFault.throwOnLocalChange = true;
    view.dispatch({ changes: { from: 4, insert: "x" } });
    vi.advanceTimersByTime(300);
    expect(editPosts()).toEqual([]);
    // Write access returns on the same lineage with the host's bytes. Nothing was
    // retained, so the reseed wins and no Edit for the readonly change goes out.
    hostDocument({ ...SNAPSHOT, docVersion: 3, canWrite: true });
    vi.advanceTimersByTime(300);
    expect(view.state.doc.toString()).toBe("seed");
    expect(editPosts()).toEqual([]);
  });
});
