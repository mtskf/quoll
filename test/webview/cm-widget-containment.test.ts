// @vitest-environment happy-dom
//
// The entry's acceptance test: force a widget's RENDER to throw during a reseed
// and pin that the session SETTLES — no throw escapes, the view
// stays usable, and the version edit-sync echoes is the one the host sent.
// Pre-containment this file's first assertion failed with the widget's own
// error and the second with CodeMirror's internal
// "Cannot destructure property 'tile' of 'parents.pop(...)'".
//
// ⚠️ `mount()`, `hostBytes()` and `editPosts()` in test/webview/editor.test.ts
// are file-private — there is no export and no shared helper. This file gives
// itself its own small mount helper (copied in shape from editor.test.ts's) —
// duplicating ~30 lines is the right trade against refactoring a 1200-line
// suite inside a bugfix PR; if a third file ever needs it, extract then.
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThematicBreakWidget } from "../../src/webview/cm/decorations/thematic-break-widget.js";
import { quollDocumentEol, serializeDocument } from "../../src/webview/cm/seed.js";
import { TableBlockWidget } from "../../src/webview/cm/table/table-widget.js";
import { type EditorHandle, mountEditor } from "../../src/webview/editor.js";
import { type Action, initialState, type WebviewState } from "../../src/webview/state.js";

const postMessage = vi.fn();
const editPosts = () =>
  postMessage.mock.calls.map((c) => c[0]).filter((m) => (m as { type?: string })?.type === "edit");

vi.mock("../../src/webview/host.js", () => ({
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

/** What the HOST would receive for this view — mirrors editor.test.ts's helper
 *  of the same name (this file's copy, per the header). */
function hostBytes(view: EditorView): string {
  return serializeDocument(view.state.doc, view.state.facet(quollDocumentEol));
}

beforeEach(() => {
  postMessage.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
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

function mount(opts: { onDispatch?: (action: Action) => void } = {}): {
  handle: EditorHandle;
  view: EditorView;
} {
  const state = makeState();
  const dispatch: (action: Action) => void = opts.onDispatch ?? (() => {});
  const handle = mountEditor({
    parent: container as HTMLElement,
    nonce: "test-nonce",
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
  return { handle, view };
}

it("a throwing widget render leaves the session fully settled", () => {
  const { handle, view } = mount();
  handle.applyDocument("seed\n", true, 1);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // ⚠️ Spy `render`, NOT `toDOM`. `toDOM` is the base's contained entry point,
  // so replacing it would bypass the exact mechanism under test.
  const spy = vi
    .spyOn(ThematicBreakWidget.prototype as unknown as { render: () => HTMLElement }, "render")
    .mockImplementation(() => {
      throw new Error("forced render failure");
    });

  expect(() => handle.applyDocument("a\n\n---\n\nb\n", true, 7)).not.toThrow();
  // The wedge test: a SECOND snapshot still lands. This is the assertion that
  // fails without containment even after the widget is healthy again.
  expect(() => handle.applyDocument("a\n\n---\n\nbb\n", true, 8)).not.toThrow();
  spy.mockRestore();

  expect(hostBytes(view)).toBe("a\n\n---\n\nbb\n");
  expect(document.querySelector("[data-quoll-widget-error]")).not.toBeNull();

  // No silent version divergence: the next local edit echoes the host's v8.
  view.dispatch({ changes: { from: 0, insert: "X" } });
  handle.flushPending();
  expect(editPosts().at(-1)?.baseDocVersion).toBe(8);
});

it("a StateField block widget: a throwing table render settles the same way", () => {
  // The entry names a StateField widget, and `tableBlockField` is one
  // (cm-block-widget-statefield-guard.test.ts pins that). This case also gives
  // the ONE hook the plan calls not-display-only — `dispose` — a real
  // implementation to run against, instead of the synthetic stub in
  // widget-base.test.ts.
  const { handle, view } = mount();
  handle.applyDocument("seed\n", true, 1);
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const spy = vi
    .spyOn(TableBlockWidget.prototype as unknown as { render: () => HTMLElement }, "render")
    .mockImplementation(() => {
      throw new Error("forced table render failure");
    });
  // ⚠️ The document MUST start with prose and the caret MUST stay out of the
  // table: `table-field.ts:128` hides a table the caret overlaps, and a reseed
  // leaves the caret at 0. Measured with a bare table document: render 0 calls,
  // patch 0 calls, 0 table elements — every assertion below would have been
  // vacuous.
  const table = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
  expect(() => handle.applyDocument(table, true, 7)).not.toThrow();
  expect(() => handle.applyDocument(`${table}\ntail\n`, true, 8)).not.toThrow();
  // Assert the hook actually ran, rather than inferring it from the placeholder.
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
  expect(document.querySelector("[data-quoll-widget-error]")).not.toBeNull();
  // One line, not one per rebuild — the latch is per (hook, widget).
  expect(err).toHaveBeenCalledTimes(1);
  view.dispatch({ changes: { from: 0, insert: "X" } });
  handle.flushPending();
  expect(editPosts().at(-1)?.baseDocVersion).toBe(8);
});

it("a throwing table patch tears the old element down and never writes bytes", () => {
  // The containment path that has a real `dispose` behind it: force `patchDOM`
  // to throw on a mounted table and pin that (a) nothing escapes, (b) the log is
  // latched to one line, (c) `dispose` runs TWICE (once from the catch's
  // `prev.destroy(dom)`, once from CodeMirror's `destroyDropped`) and throws
  // never, and (d) the reseed's bytes land unchanged with no placeholder left
  // over. Each of (a)-(d) has its own assertion below — (c) used to be claimed
  // in this comment and observed by nothing, which let `prev.destroy(dom)` be
  // deleted with this whole file still green.
  const { handle, view } = mount();
  // Same caret caveat as above: prose first, so the table is actually rendered.
  const v1 = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
  const v2 = "intro\n\n| a | b |\n| - | - |\n| 9 | 2 |\n";
  handle.applyDocument(v1, true, 1);
  // Arm the table's document-level drag listeners, so this exercises a real
  // `dispose` with something to abort rather than a no-op one.
  const cell = document.querySelector(".quoll-table-block td") as HTMLElement | null;
  cell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  // ⚠️ NOT mocked — the real teardown has to run. This counts it, which `err`
  // cannot: `reportOnce` latches per (hook, widget) and counts LOG LINES, so its
  // `1` is the same whether teardown ran twice, once, or not at all.
  const disposed = vi.spyOn(
    TableBlockWidget.prototype as unknown as { dispose: (dom: HTMLElement) => void },
    "dispose"
  );
  const spy = vi
    .spyOn(TableBlockWidget.prototype as unknown as { patchDOM: () => boolean }, "patchDOM")
    .mockImplementation(() => {
      throw new Error("forced table patch failure");
    });
  const before = hostBytes(view);
  expect(() => handle.applyDocument(v2, true, 2)).not.toThrow();
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
  expect(err).toHaveBeenCalledTimes(1);
  expect(hostBytes(view)).toBe(v2);
  expect(before).not.toBe(hostBytes(view)); // the reseed really happened
  // (c) The owning widget's OWN teardown really ran, TWICE: once from the catch
  // (`prev.destroy(dom)` — the only route that reaches the widget that armed the
  // document-level drag listeners, while its children are still in place), and
  // once more from `destroyDropped` (`view dist:3461` → `:3465`), because the
  // catch returns `false` so the tile is never marked reused. That double call
  // is why `dispose` implementations are required to be idempotent.
  expect(disposed).toHaveBeenCalledTimes(2);
  // (d) The taint stops the tile being reused, so `destroyDropped` drops it and
  // the position is redrawn by a fresh, healthy `toDOM`.
  // ⚠️ This assertion does NOT pin the taint, despite what it used to claim:
  // measured, it stays green with `tainted.add(prev)` deleted, because
  // `destroyDropped` redraws the position either way. What it pins is the
  // SYSTEM-level consequence — a failed patch leaves no placeholder on screen in
  // a real mount. The taint's own two readers (`eq`, and `updateDOM`'s
  // `tainted.has(prev)` arm) are pinned directly, one test each, in
  // test/webview/cm/widget-base.test.ts.
  expect(document.querySelector("[data-quoll-widget-error]")).toBeNull();
  expect(document.querySelector(".quoll-table-block")).not.toBeNull();
});

it("non-vacuity: bypassing the base reproduces the wedge", () => {
  // Stub the CONTAINED entry point itself — the pre-fix shape. `vi.spyOn` walks
  // the prototype chain, so this replaces the base's `toDOM` for this class and
  // nothing contains the throw. If this test ever goes green on its own, either
  // CodeMirror started containing widget DOM construction or the containment
  // moved — and the base class's whole rationale needs re-reading.
  const { handle } = mount();
  handle.applyDocument("seed\n", true, 1);
  const spy = vi.spyOn(ThematicBreakWidget.prototype, "toDOM").mockImplementationOnce(() => {
    throw new Error("forced widget failure");
  });
  expect(() => handle.applyDocument("a\n\n---\n\nb\n", true, 7)).toThrow();
  spy.mockRestore();
  // The wedge, pinned: the view cannot apply another snapshot even now that the
  // widget is healthy.
  expect(() => handle.applyDocument("plain\n", true, 8)).toThrow();
});
