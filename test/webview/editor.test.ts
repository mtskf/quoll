// @vitest-environment happy-dom
import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_LENGTH, PROTOCOL_VERSION } from "../../src/shared/protocol.js";
import { applyCaret } from "../../src/webview/cm/caret.js";
import {
  blockquoteRule,
  buildBlockquoteRule,
  fencedCodePanel,
} from "../../src/webview/cm/decorations/block-style.js";
import { buildListHangIndent, listHangIndent } from "../../src/webview/cm/list/list-hang-indent.js";
import { quollOpenExternalSink } from "../../src/webview/cm/open-external.js";
import { type EditorHandle, mountEditor } from "../../src/webview/editor.js";
import { type Action, initialState, type WebviewState } from "../../src/webview/state.js";
import { fullTree } from "./helpers/full-tree.js";

// editor.ts CodeMirror-view integration tests (post C3 vanilla mount).
//
// These tests assert at the CodeMirror state-level — view.state.sliceDoc(),
// view.state.facet(...), view.state.readOnly, and the post-Edit message
// trail — because happy-dom does not faithfully fire CM's contenteditable
// input events. Programmatic transactions via view.dispatch(...) stand in
// for keystrokes for the plain-typing / paste round-trip assertions.
//
// The test group (o) "nonce-stability dev assertion" from the React era
// is DELETED in C3: vanilla mount has no rerender concept, so a "nonce
// changed across renders" assertion is unreachable and moot.

const postMessage = vi.fn();
// Filters the raw postMessage trail to only `edit`-type posts so that
// orthogonal `lint-diagnostics` posts from the debounced compute do not
// invalidate assertions about Edit traffic.
const editPosts = () =>
  postMessage.mock.calls.map((c) => c[0]).filter((m) => (m as { type?: string })?.type === "edit");

vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage }),
  subscribeToHost: () => () => {},
}));

let container: HTMLElement | null = null;
// Every editor mounted in a test is tracked here and disposed in afterEach.
// Without this, an undisposed editor keeps a live updateListener whose
// edit-sync debounce timer (DEBOUNCE_MS=300, real `setTimeout` in tests that
// run without fake timers) outlives the test. When a later test awaits real
// time (e.g. the "synchronous drain" test's `advanceTimersByTimeAsync`), that
// orphaned timer fires and posts a stray Edit into the next test's freshly
// reset postMessage trail — a cross-test leak that made the full parallel
// suite non-deterministically red. dispose() cancels the pending flush.
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
  // Dispose BEFORE useRealTimers so clearTimeout in dispose() runs in the
  // same timer context the debounce was scheduled in. dispose() is
  // idempotent (CodeMirror's destroy + cancelPendingFlush + mount.remove all
  // no-op on a second call), so the few tests that dispose/unmount mid-body
  // are safe to dispose again here.
  for (const handle of mounted.splice(0)) {
    handle.dispose();
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type MountResult = {
  handle: EditorHandle;
  view: EditorView;
  setState: (next: WebviewState) => void;
  commit: (editInFlight: boolean) => void;
  unmount: () => void;
};

function mount(
  opts: { state?: WebviewState; onDispatch?: (action: Action) => void; nonce?: string } = {}
): MountResult {
  let state = opts.state ?? makeState();
  const dispatch: (action: Action) => void = opts.onDispatch ?? (() => {});
  const handle = mountEditor({
    parent: container as HTMLElement,
    nonce: opts.nonce ?? "test-nonce",
    getState: () => state,
    dispatch,
  });
  mounted.push(handle);
  const mountEl = container?.querySelector(".quoll-editor") as HTMLElement | null;
  if (!mountEl) {
    throw new Error("Editor mount node missing");
  }
  const view = EditorView.findFromDOM(mountEl);
  if (!view) {
    throw new Error("EditorView not found via findFromDOM");
  }
  return {
    handle,
    view,
    setState(next) {
      state = next;
    },
    commit(editInFlight) {
      handle.onReducerCommit(editInFlight);
    },
    unmount() {
      handle.dispose();
    },
  };
}

// (a) applyDocument(rawText, true, 1) puts rawText into view.state.sliceDoc().
describe("editor — applyDocument seeds the CM doc (a)", () => {
  it("rawText reaches view.state.sliceDoc() through the facet-aware read", () => {
    const { handle, view } = mount();
    handle.applyDocument("# hello\n\nworld", true, 1);
    expect(view.state.sliceDoc()).toBe("# hello\n\nworld");
  });
});

// (a2) quollTokenMarkers is wired into the PRODUCTION editor extension list.
// The render test (cm-decoration-setext-nascent-render) mounts its own extension
// list, so it proves the marker+keep-rule MECHANISM but not that editor.ts still
// mounts the marker layer. This guards that seam: a strong span in the real editor
// must carry the stable `quoll-tok-strong` class the nascent-setext keep-rule binds
// to. Non-vacuous: drop `quollTokenMarkers` from editor.ts and this reds.
describe("editor — nascent-setext token markers wired (production mount)", () => {
  it("a strong span carries the quoll-tok-strong marker class", () => {
    const { handle, view } = mount();
    handle.applyDocument("Foo **bar**", true, 1);
    const line = view.contentDOM.querySelector(".cm-line");
    const bar = [...(line?.querySelectorAll("span") ?? [])]
      .reverse()
      .find((s) => s.textContent?.includes("bar"));
    expect(bar?.classList.contains("quoll-tok-strong")).toBe(true);
  });
});

// (b) Host reseed of identical bytes posts no Edit (seeding + cancelPendingFlush).
describe("editor — idempotent reseed posts no Edit (b)", () => {
  it("identical rawText reseed produces no Edit on the post trail", () => {
    vi.useFakeTimers();
    const { handle } = mount();
    handle.applyDocument("seed", true, 1);
    expect(editPosts()).toHaveLength(0);
    handle.applyDocument("seed", true, 2);
    vi.advanceTimersByTime(1000);
    expect(editPosts()).toHaveLength(0);
  });
});

// (c) Readonly via BOTH facets driven by the canWrite PARAM directly.
describe("editor — canWrite param drives BOTH editable + readOnly facets (c)", () => {
  it("applyDocument(_, false, _) flips readOnly+editable WITHOUT changing state.canWrite, then (_, true, _) flips back", () => {
    const heldState = makeState({ canWrite: true });
    const { handle, view } = mount({ state: heldState });
    handle.applyDocument("body", false, 1);
    expect(view.state.readOnly).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    handle.applyDocument("body", true, 2);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
  });
});

// (d) Fresh-canWrite seed: applyDocument fires BEFORE getState would see the
// next reducer commit, so the Compartment + replay gate must use the param.
describe("editor — fresh canWrite from applyDocument drives Compartment + replay (d)", () => {
  it("(rawText, true, _) with stale state.canWrite=false leaves view writable AND drains buffered Edit on commit", () => {
    vi.useFakeTimers();
    const { handle, view, setState, commit } = mount({
      state: makeState({ canWrite: false }),
    });
    // applyDocument with FRESH canWrite=true — drives the Compartment off
    // the PARAM regardless of the stale state.canWrite reader.
    handle.applyDocument("seed", true, 1);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    vi.advanceTimersByTime(300);
    expect(editPosts()).toHaveLength(1);
    const call = editPosts()[0] as {
      type: string;
      content: string;
      baseDocVersion: number;
    };
    expect(call.type).toBe("edit");
    expect(call.baseDocVersion).toBe(1);
    expect(call.content).toBe("seedx");
    // Simulate the shell's post-dispatch drain after the host ack.
    setState(makeState({ canWrite: true, editInFlight: true, docVersion: 1 }));
    commit(true);
  });
});

// (e) CRLF round-trip — uniform CRLF + LF round-trip + DEFENSIVE mixed/CR-only
// seam normalization. The host seeds canonicalDocumentText(document) (see
// document-canonical.ts), so these raw mixed/CR-only inputs never reach the
// seam in production (pinned by document-canonical.test.ts + the
// mixed-eol-roundtrip e2e); these cases characterize the fallback, not a
// user-facing path.
describe("editor — CRLF/LF round-trip uniform scope (e)", () => {
  it("CRLF seed is byte-identical and the line model is clean (no stray \\r in line 1)", () => {
    const { handle, view } = mount();
    handle.applyDocument("a\r\nb\r\nc", true, 1);
    expect(view.state.sliceDoc()).toBe("a\r\nb\r\nc");
    expect(view.state.doc.lines).toBe(3);
    expect(view.state.doc.line(1).text).toBe("a");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\r\nd" } });
    expect(view.state.sliceDoc()).toBe("a\r\nb\r\nc\r\nd");
  });

  it("LF seed round-trips byte-identically", () => {
    const { handle, view } = mount();
    handle.applyDocument("a\nb\nc", true, 1);
    expect(view.state.sliceDoc()).toBe("a\nb\nc");
    expect(view.state.doc.lines).toBe(3);
    expect(view.state.doc.line(1).text).toBe("a");
  });

  it("mixed-EOL seed normalizes to CRLF (documented limitation per fix #22)", () => {
    const { handle, view } = mount();
    handle.applyDocument("a\r\nb\nc", true, 1);
    expect(view.state.sliceDoc()).toBe("a\r\nb\r\nc");
  });

  it("CR-only seed defensively normalizes to LF (host seeds canonical; raw CR-only is unreachable in prod)", () => {
    const { handle, view } = mount();
    handle.applyDocument("a\rb\rc", true, 1);
    // detectLineSeparator returns "\n" when no "\r\n" is present, so the
    // split-on-/\r\n?|\n/ + sliceDoc() rejoin yields LF. The host never
    // delivers raw CR-only bytes (it seeds canonicalDocumentText), so this
    // pins the seam's defensive behavior, not a user-facing path.
    expect(view.state.sliceDoc()).toBe("a\nb\nc");
  });
});

// (f) Plain typing / paste round-trip — dispatch posts the exact Edit content.
describe("editor — plain typing + paste round-trip posts the exact Edit (f)", () => {
  it("a programmatic insert round-trips through sliceDoc + posts the exact Edit content", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("seed", true, 1);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "typed" } });
    expect(view.state.sliceDoc()).toBe("seedtyped");
    vi.advanceTimersByTime(300);
    expect(editPosts()).toHaveLength(1);
    const call = editPosts()[0] as {
      type: string;
      content: string;
      baseDocVersion: number;
    };
    expect(call.type).toBe("edit");
    expect(call.content).toBe("seedtyped");
    expect(call.baseDocVersion).toBe(1);
  });

  it("a paste-shaped insert (large block) round-trips and posts the exact pasted content", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("", true, 1);
    const paste = "Para one.\n\nPara two with `code`.\n\n- list a\n- list b\n";
    view.dispatch({ changes: { from: 0, insert: paste } });
    expect(view.state.sliceDoc()).toBe(paste);
    vi.advanceTimersByTime(300);
    expect(editPosts()).toHaveLength(1);
    const call = editPosts()[0] as { content: string };
    expect(call.content).toBe(paste);
  });
});

// (g) Parse-failure-shaped seed: identical 3-arg shape, same flip pattern.
describe("editor — parse-failure-shaped seed still tracks canWrite (g)", () => {
  it("applyDocument(rawText, false, v) → readOnly+editable=false; (rawText, true, v+1) → readOnly+editable=true", () => {
    const { handle, view } = mount({ state: makeState({ canWrite: true }) });
    handle.applyDocument("raw with [broken", false, 1);
    expect(view.state.readOnly).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    handle.applyDocument("raw with [broken", true, 2);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
  });
});

// (k) dispose() cancels the pending flush — no empty-string Edit.
describe("editor — dispose cancels pending flush (k)", () => {
  it("typing then dispose BEFORE debounce fires posts NO Edit", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("seed", true, 1);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    expect(postMessage).not.toHaveBeenCalled();
    handle.dispose();
    vi.advanceTimersByTime(1000);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

// V-M13(a) (C3): debounce-driven first-post path throw surface.
// postEditMessage catches a throw and dispatches serialize-error; without
// this guard, editInFlight would stay true forever (no Document arrives
// because the host never received the Edit). Pin via injecting a host
// mock whose postMessage throws on the FIRST call only.
describe("editor — postEditMessage debounce-path throw surface (V-M13(a))", () => {
  it("dispatches serialize-error + logs console.error when the first debounced post throws", async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Replace the postMessage mock for this test only — throws on the first
    // edit post. Scoped to type==="edit" so orthogonal lint-diagnostics posts
    // (from the debounced compute that fires in the same timer window) do not
    // consume the throw slot before the edit arrives.
    let calls = 0;
    postMessage.mockImplementation((m) => {
      if ((m as { type?: string })?.type === "edit") {
        calls++;
        if (calls === 1) {
          throw new Error("structuredClone failed");
        }
      }
    });
    const dispatchSpy = vi.fn();
    const { handle, view } = mount({ onDispatch: dispatchSpy });
    handle.applyDocument("seed", true, 1);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    vi.advanceTimersByTime(300);
    // post-edit dispatched (single-flight set) THEN serialize-error
    // dispatched (catch arm). The reducer would clear editInFlight on
    // serialize-error.
    const types = dispatchSpy.mock.calls.map(([a]) => (a as { type: string }).type);
    expect(types).toContain("post-edit");
    expect(types).toContain("serialize-error");
    // The serialize-error action carries the host's throw message.
    const errAction = dispatchSpy.mock.calls.find(
      ([a]) => (a as { type: string }).type === "serialize-error"
    )?.[0] as { error: { message: string } };
    expect(errAction.error.message).toContain("structuredClone failed");
    // One [quoll] log surfaces the throw.
    const quollLogs = consoleSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("[quoll] postMessage(edit) failed")
    );
    expect(quollLogs.length).toBe(1);
    consoleSpy.mockRestore();
  });
});

// V-M13(b): a throw from `dispatch` itself, inside postEditMessage's onError
// callback, must not propagate out of the debounce-driven flush. Without a
// guard around this inner dispatch call, editInFlight (set true by the prior
// post-edit dispatch) would never be cleared by serialize-error, silently
// blocking all further edits (state.ts's post-edit case: `if (editInFlight)
// return state`).
describe("editor — postEditMessage survives a throwing serialize-error dispatch (V-M13(b))", () => {
  it("logs and does not propagate when the serialize-error dispatch itself throws", () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    postMessage.mockImplementation((m) => {
      if ((m as { type?: string })?.type === "edit") {
        calls++;
        if (calls === 1) {
          throw new Error("structuredClone failed");
        }
      }
    });
    const dispatchSpy = vi.fn((action: Action) => {
      if (action.type === "serialize-error") {
        throw new Error("dispatch exploded");
      }
    });
    const { handle, view } = mount({ onDispatch: dispatchSpy });
    handle.applyDocument("seed", true, 1);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    // Must not throw out of the debounce-driven flush.
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    const quollLogs = consoleSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("[quoll] serialize-error dispatch itself failed")
    );
    expect(quollLogs.length).toBe(1);
    // The inner catch must fully absorb the throw — safePostMessage's own
    // outer onError catcher (safe-post-message.ts) must never see it, or the
    // error would surface twice.
    const outerLogs = consoleSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("[quoll] onError for postMessage(edit) failed")
    );
    expect(outerLogs.length).toBe(0);
    consoleSpy.mockRestore();
  });
});

// V-M14: a throw from `dispatch` on the post-edit action itself (the FIRST
// dispatch call in postEditMessage, before the Edit message is even built)
// must not propagate out of the debounce-driven flush. Symmetric with
// V-M13(b)'s guard around the serialize-error dispatch.
describe("editor — postEditMessage survives a throwing post-edit dispatch (V-M14)", () => {
  it("logs and does not propagate when the post-edit dispatch itself throws, and still posts the edit", () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatchSpy = vi.fn((action: Action) => {
      if (action.type === "post-edit") {
        throw new Error("post-edit dispatch exploded");
      }
    });
    const { handle, view } = mount({ onDispatch: dispatchSpy });
    handle.applyDocument("seed", true, 1);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    // Must not throw out of the debounce-driven flush.
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();
    const quollLogs = consoleSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" && args[0].includes("[quoll] post-edit dispatch itself failed")
    );
    expect(quollLogs.length).toBe(1);
    // The dispatch throw is swallowed, not a short-circuit — the Edit message
    // still ships to the host afterward.
    expect(editPosts()).toHaveLength(1);
    consoleSpy.mockRestore();
  });
});

// Oversized doc: an edit whose content exceeds MAX_CONTENT_LENGTH would be
// silently dropped by the host boundary validator (isBoundedContent →
// console.warn, no edit-rejected), so the webview MUST intercept it on the
// post path and route it to the serialize-error banner. Without the gate the
// over-limit `edit` posts, editInFlight latches on the ack that never comes,
// and every later keystroke replay-drops with NO user-visible signal.
describe("editor — oversized edit is gated to the serialize-error banner (oversized-doc)", () => {
  it("an over-limit doc posts NO edit, dispatches serialize-error, and never latches post-edit", () => {
    vi.useFakeTimers();
    const dispatchSpy = vi.fn();
    const { handle, view } = mount({ onDispatch: dispatchSpy });
    handle.applyDocument("seed", true, 1);
    // Replace the whole doc with an over-limit body (one code unit past the cap).
    const oversized = "a".repeat(MAX_CONTENT_LENGTH + 1);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: oversized } });
    vi.advanceTimersByTime(300);
    // The over-limit edit is intercepted on the post path — nothing reaches the host.
    expect(editPosts()).toHaveLength(0);
    const types = dispatchSpy.mock.calls.map(([a]) => (a as { type: string }).type);
    // serialize-error surfaces the banner; post-edit is NEVER dispatched, so the
    // reducer's editInFlight cannot latch.
    expect(types).toContain("serialize-error");
    expect(types).not.toContain("post-edit");
    const errAction = dispatchSpy.mock.calls.find(
      ([a]) => (a as { type: string }).type === "serialize-error"
    )?.[0] as { error: { message: string } };
    expect(errAction.error.message).toMatch(/too large/i);
  });

  it("an at-limit doc (exactly MAX_CONTENT_LENGTH) still posts a normal edit", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("", true, 1);
    // Exactly the cap is BOUNDED (isBoundedContent uses `<=`), so it must post.
    const atLimit = "a".repeat(MAX_CONTENT_LENGTH);
    view.dispatch({ changes: { from: 0, insert: atLimit } });
    vi.advanceTimersByTime(300);
    expect(editPosts()).toHaveLength(1);
    const call = editPosts()[0] as { content: string };
    expect(call.content.length).toBe(MAX_CONTENT_LENGTH);
  });
});

// (l) Atomic seed transaction — no readonly-empty intermediate.
describe("editor — atomic seed transaction (l)", () => {
  it("seeding from a readonly prior state lands BOTH the new doc AND editable=true in ONE update", async () => {
    const { handle, view } = mount();
    handle.applyDocument("old", false, 1);
    expect(view.state.readOnly).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    const observed: Array<{ doc: string; editable: boolean; readOnly: boolean }> = [];
    const { StateEffect } = await import("@codemirror/state");
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          observed.push({
            doc: u.state.sliceDoc(),
            editable: u.state.facet(EditorView.editable),
            readOnly: u.state.readOnly,
          });
        })
      ),
    });
    observed.length = 0;
    handle.applyDocument("new", true, 2);
    expect(observed.length).toBe(1);
    expect(observed[0]).toEqual({ doc: "new", editable: true, readOnly: false });
  });
});

// (m) CSP nonce reaches EditorView.cspNonce facet.
describe("editor — nonce reaches EditorView.cspNonce facet (m)", () => {
  it("nonce param is on view.state.facet(EditorView.cspNonce)", () => {
    const { view } = mount({ nonce: "test-nonce" });
    expect(view.state.facet(EditorView.cspNonce)).toBe("test-nonce");
  });
});

// (n) GFM tree is active (Strikethrough / Table / TaskMarker nodes present).
describe("editor — GFM tree active (n)", () => {
  it("strike + table + task fixture produces Strikethrough / Table / TaskMarker nodes", () => {
    const { handle, view } = mount();
    const fixture = "~~s~~\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] task";
    handle.applyDocument(fixture, true, 1);
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    expect(tree).not.toBeNull();
    if (tree === null) {
      throw new Error("syntax tree unavailable");
    }
    const seen = new Set<string>();
    tree.iterate({
      enter: (node) => {
        seen.add(node.name);
      },
    });
    expect(seen).toContain("Strikethrough");
    expect(seen).toContain("Table");
    expect(seen).toContain("TaskMarker");
  });
});

// (p) Host-seed transactions are excluded from undo history.
describe("editor — host-seed dispatch excluded from undo history (p)", () => {
  it("undo returns false after seed; real edits are undoable; reseed does not add to history", async () => {
    const { undo } = await import("@codemirror/commands");
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    expect(undo(view)).toBe(false);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    expect(undo(view)).toBe(true);
    handle.applyDocument("hello\nworld", true, 2);
    expect(undo(view)).toBe(false);
  });
});

// (q) Caret survives a reseed where view doc diverged past the host snapshot.
// Repro: user keeps typing during an accept round-trip; the host's ack carries
// the pre-typing snapshot; applyDocument's needsReseed branch fires a wholesale
// 0..doc.length replace which collapses the selection through CM's default
// change mapping. The caret is captured before the reseed and re-applied
// (clamped to the new doc bounds) so the user keeps editing where they were.
describe("editor — caret preserved across accept-and-reseed (q)", () => {
  it("caret at mid-doc stays put when reseed shrinks the doc past the user's typing", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    // Move caret to position 3 (between "hel" and "lo world").
    view.dispatch({ selection: { anchor: 3 } });
    expect(view.state.selection.main.head).toBe(3);
    // User typed 'X' at the tail while an Edit was already in flight —
    // the host snapshot does not yet carry the X, so view doc diverges
    // past the rawText we're about to reseed with.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "X" } });
    expect(view.state.sliceDoc()).toBe("hello worldX");
    // Host ack arrives without the in-window 'X'. needsReseed = true.
    handle.applyDocument("hello world", true, 2);
    expect(view.state.sliceDoc()).toBe("hello world");
    // The user's caret was at position 3 — well within the new doc
    // length (11). It must stay at 3 rather than being remapped to the
    // change boundary.
    expect(view.state.selection.main.head).toBe(3);
    expect(view.state.selection.main.anchor).toBe(3);
  });

  it("caret past the new doc end is clamped to the end instead of resetting to 0", () => {
    const { handle, view } = mount();
    handle.applyDocument("hi", true, 1);
    // User types two characters at end; caret follows the typing.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "ab" },
      selection: { anchor: 4 },
    });
    expect(view.state.sliceDoc()).toBe("hiab");
    expect(view.state.selection.main.head).toBe(4);
    // Reseed to the shorter host snapshot — caret was past new end.
    handle.applyDocument("hi", true, 2);
    expect(view.state.sliceDoc()).toBe("hi");
    // Clamp to new doc length (2). NOT zero, NOT the original 4.
    expect(view.state.selection.main.head).toBe(2);
  });

  it("caret is clamped to 0 when reseed empties the doc", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    view.dispatch({ selection: { anchor: 5 } });
    expect(view.state.selection.main.head).toBe(5);
    handle.applyDocument("", true, 2);
    expect(view.state.sliceDoc()).toBe("");
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.selection.main.anchor).toBe(0);
  });

  it("range selection is preserved when both endpoints fit in the new doc", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    view.dispatch({ selection: { anchor: 1, head: 5 } });
    handle.applyDocument("hello worldX", true, 2);
    expect(view.state.selection.main.anchor).toBe(1);
    expect(view.state.selection.main.head).toBe(5);
  });

  it("range selection is clamped when the reseed doc is shorter than head", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    view.dispatch({ selection: { anchor: 3, head: 8 } });
    handle.applyDocument("hello", true, 2);
    expect(view.state.selection.main.anchor).toBe(3);
    expect(view.state.selection.main.head).toBe(5);
  });

  it("range selection is clamped when both anchor and head exceed the reseed doc length", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    view.dispatch({ selection: { anchor: 7, head: 9 } });
    handle.applyDocument("hi", true, 2);
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.state.selection.main.head).toBe(2);
  });

  it("same-content reseed (needsReseed=false) does NOT disturb the selection", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    view.dispatch({ selection: { anchor: 3, head: 6 } });
    expect(view.state.selection.main.anchor).toBe(3);
    expect(view.state.selection.main.head).toBe(6);
    handle.applyDocument("hello world", true, 2);
    expect(view.state.sliceDoc()).toBe("hello world");
    expect(view.state.selection.main.anchor).toBe(3);
    expect(view.state.selection.main.head).toBe(6);
  });

  it("multi-cursor is collapsed to main-only on reseed (KISS intentional)", async () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    const { EditorSelection } = await import("@codemirror/state");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(7)]),
    });
    expect(view.state.selection.ranges.length).toBe(2);
    handle.applyDocument("hello world!", true, 2);
    expect(view.state.selection.ranges.length).toBe(1);
    expect(view.state.selection.main.head).toBe(3);
  });

  it("seeding guard resets to false even when dispatch throws inside applyDocument", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("initial", true, 1);
    const spy = vi.spyOn(view, "dispatch").mockImplementationOnce(() => {
      throw new Error("dispatch test throw");
    });
    try {
      expect(() => handle.applyDocument("other", true, 2)).toThrow("dispatch test throw");
    } finally {
      spy.mockRestore();
    }
    // seeding must be false — a subsequent user dispatch must reach onLocalChange.
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
    vi.advanceTimersByTime(300);
    expect(postMessage).toHaveBeenCalled();
  });
});

describe("editor — local-edit-attempt + discardBuffer on docChanged", () => {
  it("dispatches local-edit-attempt + calls discardBuffer when serializeError is set", () => {
    const onDispatch = vi.fn();
    const stateWithError: WebviewState = {
      ...makeState(),
      serializeError: {
        code: "unsafe_url",
        message: "URL is not in the allowlist: javascript:alert(1)",
      },
    };
    const { view, handle } = mount({
      state: stateWithError,
      onDispatch,
    });
    handle.applyDocument("hello\n", true, 1);

    // Programmatic transaction stands in for a keystroke.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "x" },
    });

    // local-edit-attempt fired (synchronous inside the updateListener).
    const localEditCalls = onDispatch.mock.calls.filter(
      ([action]) => (action as { type: string }).type === "local-edit-attempt"
    );
    expect(localEditCalls.length).toBe(1);
  });

  it("does NOT dispatch local-edit-attempt when serializeError is null", () => {
    const onDispatch = vi.fn();
    const { view, handle } = mount({
      state: makeState(),
      onDispatch,
    });
    handle.applyDocument("hello\n", true, 1);

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "x" },
    });

    const localEditCalls = onDispatch.mock.calls.filter(
      ([action]) => (action as { type: string }).type === "local-edit-attempt"
    );
    expect(localEditCalls.length).toBe(0);
  });

  it("on retry-keystroke, the synchronous drain does NOT replay stale buffered bytes", async () => {
    // Setup steps (production-faithful):
    //   1. Mount with NO error, debounce in real time (vi.useFakeTimers covers the 300ms).
    //   2. Drive an Edit into in-flight via docChanged + debounce fire.
    //   3. Drive a SECOND docChanged while in-flight to populate `buffered` with pre-reject doc bytes.
    //   4. Simulate the host's edit-rejected via setState (clear editInFlight + set serializeError)
    //      and call commit(false). The reducer's serialize-error arm would do the same in production.
    //   5. The user's "fix" keystroke fires the updateListener. With discardBuffer-before-dispatch,
    //      the synchronous drain sees an empty buffer and short-circuits. With the WRONG order, the
    //      drain would post the stale pre-reject bytes — the test catches that as an extra postMessage.
    vi.useFakeTimers();
    try {
      const onDispatch = vi.fn();
      const initial = makeState();
      const m = mount({ state: initial, onDispatch });

      m.handle.applyDocument("safe\n", true, 1);

      // (2) post → in-flight
      m.view.dispatch({ changes: { from: m.view.state.doc.length, insert: "X" } });
      await vi.advanceTimersByTimeAsync(350);
      expect(editPosts()).toHaveLength(1);
      const firstPost = editPosts()[0] as { content: string };
      expect(firstPost.content).toMatch(/safe\nX/);

      // (3) SECOND docChanged while in-flight → buffered = "safe\nXY"
      m.view.dispatch({ changes: { from: m.view.state.doc.length, insert: "Y" } });
      await vi.advanceTimersByTimeAsync(350);
      expect(editPosts()).toHaveLength(1);

      // (4) Simulate edit-rejected: flip state to serialize-error+editInFlight=false then commit.
      m.setState({
        ...initial,
        ready: true,
        docVersion: 1,
        canWrite: true,
        editInFlight: false,
        serializeError: {
          code: "unsafe_url",
          message: "URL is not in the allowlist: javascript:alert(1)",
        },
      });
      m.commit(false);

      // No replay:
      //   - commit(false) syncs edit-sync's internal editInFlight to false, then calls
      //     replayIfNeeded. replayIfNeeded hits !canPost() (state.serializeError is set)
      //     and returns early WITHOUT consuming buffered.
      // buffered still holds "safe\nXY" after this call.
      expect(editPosts()).toHaveLength(1);

      // (5) User types the "fix" keystroke. updateListener:
      //   a) detects serializeError != null
      //   b) calls sync.discardBuffer() → buffered = null
      //   c) dispatches local-edit-attempt → reducer clears serializeError. shell's dispatch
      //      wrapper would synchronously fire onReducerCommit(false). Emulate by flipping
      //      state then calling commit(false) right after the dispatch.
      //   d) drain sees buffered === null → no-op
      //   e) sync.onLocalChange() → schedule trySend for 300ms
      onDispatch.mockImplementation((action) => {
        if ((action as { type: string }).type === "local-edit-attempt") {
          m.setState({
            ...initial,
            ready: true,
            docVersion: 1,
            canWrite: true,
            editInFlight: false,
            serializeError: null,
          });
          m.commit(false);
        }
      });
      m.view.dispatch({ changes: { from: m.view.state.doc.length, insert: "Z" } });

      // No synchronous post — drain short-circuited because discardBuffer() ran BEFORE dispatch.
      expect(editPosts()).toHaveLength(1);

      // Debounce fires → trySend reads FRESH getDoc() (now "safe\nXYZ") and posts that.
      await vi.advanceTimersByTimeAsync(350);
      expect(editPosts()).toHaveLength(2);
      const secondPost = editPosts()[1] as { content: string };
      expect(secondPost.content).toMatch(/safe\nXYZ/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("editor — list hang-indent wiring", () => {
  it("registers the list hang-indent plugin and decorates a seeded list line", () => {
    const m = mount();
    m.handle.applyDocument(`- ${"word ".repeat(40)}`, true, 1);
    // Wiring: the const ViewPlugin is registered AND exposes its decorations
    // accessor on the mounted view (proves the `{ decorations }` wiring, not
    // just registration). `.toBeDefined()` is viewport-independent (happy-dom
    // may report an empty viewport, so we don't assert `.size` on the live
    // plugin here).
    const plugin = m.view.plugin(listHangIndent);
    expect(plugin).not.toBeNull();
    expect(plugin?.decorations).toBeDefined();
    // Provider produces a line decoration for the seeded list line (computed
    // from the live view state on a forced parse — robust to happy-dom's
    // empty viewport / lazy syntax tree).
    const tree = fullTree(m.view.state);
    const set = buildListHangIndent({
      state: m.view.state,
      selection: m.view.state.selection,
      visibleRanges: [{ from: 0, to: m.view.state.doc.length }],
      tree,
    });
    expect(set.size).toBeGreaterThan(0);
    m.unmount();
  });
});

// (r) Block-on-open via the REAL applyDocument seed (not just create()).
describe("editor — frontmatter block-on-open via applyDocument seed (r)", () => {
  it("a frontmatter doc seeds COLLAPSED, span on the de-markdown facet", async () => {
    const { frontmatterBlockField } = await import("../../src/webview/cm/frontmatter/index.js");
    const { quollSyntaxExclusionZones } = await import(
      "../../src/webview/cm/decorations/orchestrator.js"
    );
    const { handle, view } = mount();
    handle.applyDocument("---\ntitle: x\n---\n\n# Body\n", true, 1);
    expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
    expect(view.state.facet(quollSyntaxExclusionZones)).toEqual([{ from: 0, to: 16 }]);
  });

  it("round-trips byte-identically through applyDocument (no injection)", () => {
    const { handle, view } = mount();
    const fm = "---\ntitle: x\n---\n\nbody\n";
    handle.applyDocument(fm, true, 1);
    expect(view.state.sliceDoc()).toBe(fm);
  });
});

// (s) ArrowUp is actually REGISTERED in the editor keymap (not just callable).
describe("editor — frontmatter ArrowUp reveal is registered (s)", () => {
  it("runScopeHandlers ArrowUp from the line below reveals through the live keymap", async () => {
    const { runScopeHandlers } = await import("@codemirror/view");
    const { frontmatterBlockField } = await import("../../src/webview/cm/frontmatter/index.js");
    const { handle, view } = mount();
    handle.applyDocument("---\ntitle: x\n---\n\n# Body\n", true, 1);
    view.dispatch({ selection: { anchor: 17 } }); // line directly below the block (TO+1)
    const handled = runScopeHandlers(
      view,
      new KeyboardEvent("keydown", { key: "ArrowUp" }),
      "editor"
    );
    expect(handled).toBe(true);
    expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
    // Caret leaving re-collapses through the live stack.
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
  });
});

// (t) A host reseed mid-reveal preserves the reveal (eh#1) — through applyDocument.
describe("editor — host reseed preserves an active reveal (t)", () => {
  it("applyDocument while revealed (caret in span, still writable) keeps it revealed", async () => {
    const { frontmatterBlockField, revealFrontmatterAt } = await import(
      "../../src/webview/cm/frontmatter/index.js"
    );
    const { handle, view } = mount();
    handle.applyDocument("---\ntitle: x\n---\n\n# Body\n", true, 1);
    revealFrontmatterAt(view, 6);
    expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
    handle.applyDocument("---\ntitle: x2\n---\n\n# Body\n", true, 2);
    expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
  });

  it("a canWrite-only reseed (same content, write revoked) collapses an active reveal", async () => {
    // The canWrite-only path: applyDocument with identical bytes makes no doc
    // change (tr.docChanged=false → skips reducer branch 0); the editable/readOnly
    // reconfigure flips writability so the post-branch normalization collapses.
    const { frontmatterBlockField, revealFrontmatterAt } = await import(
      "../../src/webview/cm/frontmatter/index.js"
    );
    const doc = "---\ntitle: x\n---\n\n# Body\n";
    const { handle, view } = mount();
    handle.applyDocument(doc, true, 1);
    revealFrontmatterAt(view, 6);
    expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
    handle.applyDocument(doc, false, 2); // same bytes, write revoked
    expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
  });
});

describe("editor — block-style wiring", () => {
  it("registers BOTH the blockquote-rule and fenced-code-panel plugins and decorates a seeded blockquote", () => {
    const m = mount();
    m.handle.applyDocument("> quoted line one\n> quoted line two", true, 1);
    // Wiring: both const ViewPlugins are registered AND expose their decorations
    // accessor (proves `{ decorations }` wiring, not just registration).
    const bq = m.view.plugin(blockquoteRule);
    const fc = m.view.plugin(fencedCodePanel);
    expect(bq).not.toBeNull();
    expect(bq?.decorations).toBeDefined();
    expect(fc).not.toBeNull();
    expect(fc?.decorations).toBeDefined();
    // Provider produces line decorations for the seeded blockquote (computed
    // from a forced parse — robust to happy-dom's empty viewport).
    const tree = fullTree(m.view.state);
    const set = buildBlockquoteRule({
      state: m.view.state,
      selection: m.view.state.selection,
      visibleRanges: [{ from: 0, to: m.view.state.doc.length }],
      tree,
    });
    expect(set.size).toBeGreaterThan(0);
    m.unmount();
  });
});

// (u) Real task-checkbox provider is de-markdowned inside revealed frontmatter (Codex #6).
describe("editor — revealed frontmatter de-markdowns the real task-checkbox provider (u)", () => {
  it("a task-shaped body line renders NO checkbox widget when revealed", async () => {
    const { revealFrontmatterAt } = await import("../../src/webview/cm/frontmatter/index.js");
    const { handle, view } = mount();
    // Body line `- [ ] x` parses as a Task; the exclusion zone must drop the
    // checkbox widget the taskCheckboxReveal provider would emit.
    const doc = "---\n- [ ] x\n---\n\nbody\n";
    handle.applyDocument(doc, true, 1);
    // Anchor 0 is in-span, on the fence line (line 1 `---`), NOT the task line
    // [4,11]. The provider's caret-on-line reveal-trigger therefore does NOT
    // suppress the checkbox — only the quollSyntaxExclusionZones contribution
    // can. Anchor 4 (on the task line) would make this test vacuous: the
    // provider would early-return regardless of the exclusion zone.
    revealFrontmatterAt(view, 0);
    expect(
      view.state.field(
        (await import("../../src/webview/cm/frontmatter/index.js")).frontmatterBlockField
      ).kind
    ).toBe("revealed");
    // No CheckboxWidget anywhere in the rendered decoration sources within [0, span.to].
    const fmTo = "---\n- [ ] x\n---".length;
    let checkboxes = 0;
    for (const source of view.state.facet(EditorView.decorations)) {
      const set = typeof source === "function" ? source(view) : source;
      const iter = set.iter();
      while (iter.value !== null) {
        const w = (iter.value.spec as { widget?: { constructor?: { name?: string } } }).widget;
        if (iter.from < fmTo && w && w.constructor && w.constructor.name === "CheckboxWidget") {
          checkboxes += 1;
        }
        iter.next();
      }
    }
    expect(checkboxes).toBe(0);
  });
});

// Task 3: the Mod-Alt-k context-handoff keymap is actually registered in the
// editor extension array (guards against a silent removal — compile + manual
// smoke alone would not catch it).
describe("editor — context-handoff keymap is registered", () => {
  it("Mod-Alt-k reaches the host as a context-handoff message", async () => {
    const { runScopeHandlers } = await import("@codemirror/view");
    const { EditorSelection } = await import("@codemirror/state");
    const { view, handle } = mount();
    handle.applyDocument("line1\nline2\nline3", true, 1);
    // Select within lines 1–2 (offset 8 is inside line2).
    view.dispatch({ selection: EditorSelection.single(0, 8) });
    // happy-dom's CM platform detection is non-deterministic, so fire BOTH
    // Ctrl-Alt-k and Cmd-Alt-k; exactly one resolves to Mod-Alt-k and posts.
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", {
          key: "k",
          altKey: true,
          ...mods,
          bubbles: true,
          cancelable: true,
        }),
        "editor"
      );
    }
    const handoff = postMessage.mock.calls
      .map((c) => c[0])
      .find(
        (m): m is { type: string } => !!m && (m as { type?: unknown }).type === "context-handoff"
      );
    expect(handoff).toMatchObject({
      type: "context-handoff",
      hasSelection: true,
      startLine: 1,
      endLine: 2,
    });
  });
});

// Folding is wired into the live editor extension array (guards against silent
// removal). The NON-VACUOUS guard is the `.cm-foldGutter` DOM, mounted ONLY by
// quollFolding()'s foldGutter(): a foldCode/foldedRanges check would pass
// vacuously because lang-markdown's foldNodeProp + CM's maybeEnable self-enable
// folding even without quollFolding() wired (see docs/LEARNING.md). The foldCode
// and byte-identical-reseed cases below are kept as behaviour checks.
describe("editor — folding is registered", () => {
  it("mounts the fold gutter (proves quollFolding is wired)", () => {
    const { view, handle } = mount();
    handle.applyDocument("- a\n  - b\n  - c\n- d\n", true, 1);
    // `.cm-foldGutter` is mounted ONLY by quollFolding()'s foldGutter() — absent
    // without the extension, present with it. The non-vacuous wiring proof.
    expect(view.dom.querySelector(".cm-foldGutter")).not.toBeNull();
  });

  it("a nested-list parent folds via the foldCode command", async () => {
    const { foldCode, foldedRanges } = await import("@codemirror/language");
    const { EditorSelection } = await import("@codemirror/state");
    const { view, handle } = mount();
    handle.applyDocument("- a\n  - b\n  - c\n- d\n", true, 1);
    view.dispatch({ selection: EditorSelection.cursor(0) }); // caret on "- a"
    expect(foldCode(view)).toBe(true);
    expect(foldedRanges(view.state).size).toBe(1);
  });

  it("a fold survives a byte-identical host reseed (ephemeral-per-open contract)", async () => {
    const { foldCode, foldedRanges } = await import("@codemirror/language");
    const { EditorSelection } = await import("@codemirror/state");
    const { view, handle } = mount();
    const doc = "- a\n  - b\n  - c\n- d\n";
    handle.applyDocument(doc, true, 1);
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(foldCode(view)).toBe(true);
    expect(foldedRanges(view.state).size).toBe(1);
    // Byte-identical reseed: applyDocument computes needsReseed=false, so it
    // dispatches NEITHER changes NOR a selection → foldState is untouched
    // (native clearTouchedFolds does not fire). The fold persists. Pins the
    // Resolution #1 "folds survive an external reseed" claim through the real
    // applyDocument path (error-handler review, Confidence 85).
    handle.applyDocument(doc, true, 2);
    expect(foldedRanges(view.state).size).toBe(1);
  });
});

// Wiring guard: editor.ts must mount quollMarkdownLanguage(), so the fold-range
// subtraction reaches the LIVE editor (Codex Conf-95). Dropping the wiring (or
// reverting to inline markdown({ base })) turns this red.
describe("editor — blockquotes are not foldable through the live editor (wiring)", () => {
  it("blockquote line yields no foldable range; heading line does", () => {
    const { handle, view } = mount();
    handle.applyDocument("# H\nbody1\nbody2\n\n> quote1\n> quote2\n", true, 1);
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const headingLine = view.state.doc.lineAt(0);
    const quotePos = view.state.doc.toString().indexOf("> quote1");
    const quoteLine = view.state.doc.lineAt(quotePos);
    expect(foldable(view.state, quoteLine.from, quoteLine.to)).toBeNull();
    expect(foldable(view.state, headingLine.from, headingLine.to)).not.toBeNull();
  });
});

describe("caret handoff (applyRemoteCaret + caret-report)", () => {
  const caretReports = () =>
    postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => (m as { type?: string })?.type === "caret-report");

  it("applyRemoteCaret moves the selection to the applyCaret offset and posts NO caret-report", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld\n!", true, 1);
    postMessage.mockReset(); // drop seed-driven posts (e.g. lint-diagnostics)
    handle.applyRemoteCaret({ line: 1, character: 2 });
    // line 1 ("world") starts at offset 6; character 2 → offset 8.
    const expected = applyCaret(view.state.doc, { line: 1, character: 2 });
    expect(expected).toBe(8);
    expect(view.state.selection.main.head).toBe(expected);
    expect(view.state.selection.main.empty).toBe(true);
    // Echo suppression: the applied caret must not bounce back as a report.
    expect(caretReports()).toHaveLength(0);
  });

  it("a user selection change posts a caret-report (debounced) with 0-based line/character", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    postMessage.mockReset();
    // Stand in for a user caret move (selection-only dispatch; not seeding, not remote).
    view.dispatch({ selection: { anchor: 3 } });
    // Debounced: nothing posts synchronously (bounds the per-selectionSet flood).
    expect(caretReports()).toHaveLength(0);
    vi.advanceTimersByTime(100);
    const reports = caretReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: "caret-report", line: 0, character: 3 });
  });

  it("coalesces a burst of selection changes into ONE trailing caret-report", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    postMessage.mockReset();
    // A drag-selection / rapid caret walk fires selectionSet many times inside
    // the debounce window; only the LAST survives as a single post.
    view.dispatch({ selection: { anchor: 1 } });
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ selection: { anchor: 5 } });
    expect(caretReports()).toHaveLength(0); // all still debounced — bounded traffic
    vi.advanceTimersByTime(100);
    const reports = caretReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: "caret-report", line: 0, character: 5 });
  });

  it("coalesces a burst of range selections to ONE report carrying the LAST selectedChars", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    postMessage.mockReset();
    // A drag-select that grows: each dispatch changes the selection length; only
    // the final extent must survive (latest-wins through the debounce).
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(caretReports()).toHaveLength(0); // still debounced
    vi.advanceTimersByTime(100);
    const reports = caretReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: "caret-report", character: 5, selectedChars: 5 });
  });

  it("reports the primary-selection char count; a collapsed caret reports 0", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    postMessage.mockReset();
    // A non-empty selection: anchor 1 → head 5 spans 4 code units.
    view.dispatch({ selection: { anchor: 1, head: 5 } });
    vi.advanceTimersByTime(100);
    expect(caretReports()[0]).toMatchObject({ type: "caret-report", selectedChars: 4 });
    // Collapsing back to a cursor reports 0 (drives the `(N selected)` suffix off).
    postMessage.mockReset();
    view.dispatch({ selection: { anchor: 3 } });
    vi.advanceTimersByTime(100);
    expect(caretReports()[0]).toMatchObject({ type: "caret-report", selectedChars: 0 });
  });

  // The "Done when" pin: the pre-switch flush. Moving the caret then switching
  // editors INSIDE the debounce window must still deliver the final caret —
  // and BEFORE switch-to-text (FIFO), so the host applies the just-moved caret
  // to the reopened text editor rather than a stale one.
  it("flushes the pending caret-report BEFORE switch-to-text on the editor switch", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    postMessage.mockReset();
    view.dispatch({ selection: { anchor: 4 } });
    expect(caretReports()).toHaveLength(0); // still debounced
    const button = container?.querySelector<HTMLButtonElement>(".quoll-switch-editor-toggle");
    expect(button).not.toBeNull();
    button?.click();
    // FIFO: the force-posted caret-report lands before switch-to-text.
    const order = postMessage.mock.calls
      .map((c) => (c[0] as { type?: string })?.type)
      .filter((t) => t === "caret-report" || t === "switch-to-text");
    expect(order).toEqual(["caret-report", "switch-to-text"]);
    expect(caretReports()[0]).toMatchObject({ type: "caret-report", line: 0, character: 4 });
    // The flush cancelled the trailing timer → no duplicate post follows.
    vi.advanceTimersByTime(100);
    expect(caretReports()).toHaveLength(1);
  });

  it("flushPending() force-posts the pending caret-report (teardown/hide)", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    postMessage.mockReset();
    view.dispatch({ selection: { anchor: 2 } });
    expect(caretReports()).toHaveLength(0); // debounced
    handle.flushPending();
    const reports = caretReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: "caret-report", line: 0, character: 2 });
    // Timer was cancelled — no duplicate trailing post.
    vi.advanceTimersByTime(100);
    expect(caretReports()).toHaveLength(1);
  });

  it("dispose() cancels a pending caret-report (no stray post through the destroyed view)", () => {
    vi.useFakeTimers();
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    postMessage.mockReset();
    view.dispatch({ selection: { anchor: 2 } });
    handle.dispose();
    vi.advanceTimersByTime(100);
    expect(caretReports()).toHaveLength(0);
  });

  it("applyRemoteCaret posts no `edit` (selection-only, document untouched)", () => {
    const { handle, view } = mount();
    handle.applyDocument("alpha\nbeta", true, 1);
    const before = view.state.sliceDoc();
    postMessage.mockReset();
    handle.applyRemoteCaret({ line: 0, character: 4 });
    expect(view.state.sliceDoc()).toBe(before); // no document mutation
    expect(editPosts()).toHaveLength(0); // existing helper; no Edit posted
  });

  // Regression: the reverse text→Quoll switch. CodeMirror only PAINTS the cursor
  // while the view is focused (`.cm-focused` — @codemirror/view sets
  // `.cm-cursor { display: none }` and reveals it only under `&.cm-focused`).
  // On a text-editor→Quoll switch the host posts caret-apply while the webview
  // iframe owns focus but CM's contenteditable does not, so applyRemoteCaret MUST
  // focus the view or the carried caret is set-but-invisible ("caret not shown").
  it("applyRemoteCaret focuses the view so the carried caret is painted", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld\n!", true, 1);
    // Precondition (non-vacuity): a freshly seeded view is unfocused — the
    // webview owns focus, CM's contenteditable does not.
    expect(view.hasFocus).toBe(false);
    handle.applyRemoteCaret({ line: 1, character: 2 });
    expect(view.hasFocus).toBe(true);
  });

  it("applyRemoteCaret focuses even when the caret is already at the target", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello\nworld", true, 1);
    // Park the caret at the exact target while unfocused (dispatch does not
    // focus) so the same-position no-op guard fires below.
    view.dispatch({ selection: { anchor: applyCaret(view.state.doc, { line: 0, character: 3 }) } });
    expect(view.hasFocus).toBe(false);
    postMessage.mockReset();
    handle.applyRemoteCaret({ line: 0, character: 3 });
    // The dispatch is skipped (position unchanged) but the caret must still be
    // painted, so the focus is not gated on the no-op guard (happy-dom's
    // document.hasFocus() is true, so the focus branch runs).
    expect(view.hasFocus).toBe(true);
    // Echo-suppression holds on this branch too: focusing must not bounce the
    // just-applied caret back as a report. Pins the "focus inside the
    // applyingRemoteCaret window" invariant against a future reorder.
    expect(caretReports()).toHaveLength(0);
  });

  it("applyRemoteCaret does NOT steal focus when the webview does not own focus", () => {
    // The active-edge caret-apply fires whenever the host panel flips active
    // (active-editor-of-active-group, NOT DOM focus) — e.g. the ⌘⌥K
    // reveal-for-mention cleanup re-activates this panel while the user's focus
    // is on the Claude composer. Focusing then would steal keystrokes into the
    // document, so the focus is gated on document.hasFocus().
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      const { handle, view } = mount();
      handle.applyDocument("hello\nworld", true, 1);
      // Sanity: the content DOM does not hold focus before the apply.
      expect(document.activeElement).not.toBe(view.contentDOM);
      postMessage.mockReset();
      handle.applyRemoteCaret({ line: 1, character: 2 });
      // Focus was NOT stolen — the content DOM never became activeElement.
      // Assert on activeElement, not view.hasFocus: the mocked document.hasFocus()
      // forces view.hasFocus false regardless, so it would be vacuous. This is
      // non-vacuous — without the gate, view.focus() would set activeElement to
      // contentDOM here (focus() ignores the hasFocus mock).
      expect(document.activeElement).not.toBe(view.contentDOM);
      // …but the caret position is still applied (visible once the user later
      // focuses the webview), and no echo report is posted.
      const expected = applyCaret(view.state.doc, { line: 1, character: 2 });
      expect(view.state.selection.main.head).toBe(expected);
      expect(caretReports()).toHaveLength(0);
    } finally {
      hasFocusSpy.mockRestore();
    }
  });
});

// Task 4: the Mod-j Codex context-handoff keymap is actually registered in the
// editor extension array (guards against a silent removal). Asserts EXACTLY one
// message so a double-registration would red the test too.
describe("editor — Codex context-handoff keymap is registered", () => {
  it("Mod-j reaches the host as exactly one codex-context-handoff message", async () => {
    const { runScopeHandlers } = await import("@codemirror/view");
    const { view, handle } = mount();
    handle.applyDocument("line1\nline2\nline3", true, 1);
    // happy-dom's CM platform detection is non-deterministic, so fire BOTH
    // Ctrl-j and Cmd-j; exactly one resolves to Mod-j and posts.
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "j", ...mods, bubbles: true, cancelable: true }),
        "editor"
      );
    }
    const codexHandoffs = postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => !!m && (m as { type?: unknown }).type === "codex-context-handoff");
    expect(codexHandoffs).toHaveLength(1);
    expect(codexHandoffs[0]).toMatchObject({ type: "codex-context-handoff" });
  });
});

// Native-spellcheck toggle: the `spellcheck` attribute on the contenteditable
// `.cm-content` is driven by the host's editor-config push through
// setSpellcheck. Defaults ON (matching quoll.editor.spellcheck), flips to
// "false"/"true" via the compartment reconfigure, and a same-value push is a
// no-op (no reconfigure dispatch). Whether Electron actually paints the red
// underlines is host-side and covered by manual smoke, not this test.
describe("editor — native spellcheck toggle", () => {
  it("defaults the contenteditable spellcheck attribute to true", () => {
    const { view } = mount();
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
  });

  it("setSpellcheck(false) flips the attribute to false and back to true", () => {
    const { handle, view } = mount();
    handle.setSpellcheck(false);
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("false");
    handle.setSpellcheck(true);
    expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
  });

  it("a same-value setSpellcheck push is a no-op (no reconfigure dispatch)", () => {
    const { handle, view } = mount();
    const dispatchSpy = vi.spyOn(view, "dispatch");
    // Already true (default) → must not reconfigure the compartment.
    handle.setSpellcheck(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
    // A real change DOES dispatch exactly once…
    handle.setSpellcheck(false);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    // …and the redundant repeat is a no-op again.
    handle.setSpellcheck(false);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    dispatchSpy.mockRestore();
  });

  it("toggling spellcheck does not mutate the document", () => {
    const { handle, view } = mount();
    handle.applyDocument("hello world", true, 1);
    const before = view.state.sliceDoc();
    handle.setSpellcheck(false);
    expect(view.state.sliceDoc()).toBe(before);
    expect(editPosts()).toHaveLength(0);
  });
});

describe("editor — quollOpenExternalSink wiring", () => {
  it("wires quollOpenExternalSink to the host — table-cell link opens route through open-external", () => {
    const { view } = mount();
    postMessage.mockClear();
    // Invoke the wired facet directly: pins that editor.ts provided the real
    // openExternalSinkFor(getHost()), not the facet's no-op default. (The widget
    // block-DOM does not render reliably under happy-dom, so exercise the facet
    // value rather than a synthesized widget click.)
    view.state.facet(quollOpenExternalSink)("https://example.com");
    expect(postMessage).toHaveBeenCalledWith({
      protocol: PROTOCOL_VERSION,
      type: "open-external",
      href: "https://example.com",
    });
  });
});
