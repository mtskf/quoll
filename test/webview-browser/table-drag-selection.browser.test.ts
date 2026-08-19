// Real-browser gate for table-cell DRAG selection (C6b, table-widget.ts +
// cell-point.ts).
//
// Why this suite exists: every drag test in test/webview/table/ builds the
// widget by hand — `widget.toDOM(stubView)` on a detached-then-appended <div>,
// with a SCRIPTED CaretResolver — so nothing there observes the two facts the
// design actually rests on:
//
//   1. the root `mousedown` / `click` listeners fire at all inside a widget
//      whose `ignoreEvent()` returns true and that lives inside CodeMirror's
//      contenteditable, and
//   2. the dispatched RANGE selection SURVIVES `DOMObserver.flush()` — the
//      exact mechanism cell-point.ts's header names as the destroyer of
//      selections made inside this island (a DOM selection CM cannot map back
//      to a document position makes it re-run `updateSelection`, collapsing to
//      `state.selection`).
//
// Neither is reachable in happy-dom: it has no layout engine, so the
// production `defaultCaretResolver` (caretPositionFromPoint /
// caretRangeFromPoint — memory quoll-cm-destroys-widget-dom-selection) returns
// nothing and a pointer coordinate cannot be mapped at all. Until this file the
// premise rested on one manual Chromium session (LEARNING.md, 2026-08-12).
//
// So these tests use REAL geometry: character rectangles measured with a DOM
// Range, real clientX/clientY, the real facet default resolver, and — before
// each gesture completes — the hostile DOM selection a native drag leaves
// behind inside the widget.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import "../../src/webview/styles.css";
import { tableBlockField, tableSkeletonField } from "../../src/webview/cm/table/index.js";
import { quollTheme } from "../../src/webview/cm/theme.js";

// Cells are plain text (no inline markup) so `renderedText.length === cellTo -
// cellFrom` holds and cell-point.ts maps a pointer to an EXACT source offset —
// the byte-alignment arm the offset assertions below depend on.
const DOC = "# Doc\n\npara\n\n| Alpha | Beta |\n| ----- | ---- |\n| gamma | delta |\n\ntail\n";
const GAMMA = DOC.indexOf("gamma");
const DELTA = DOC.indexOf("delta");

/** Drain CM's bounded measure queue (4-frame idiom shared with the sibling
 *  browser suites) so getBoundingClientRect reads a settled layout. */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    let n = 4;
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  window.getSelection()?.removeAllRanges();
  for (const n of document.body.querySelectorAll(".cm-table-drag-probe")) {
    n.remove();
  }
});

/** Production extension order for the table island (editor.ts: skeleton field
 *  BEFORE the block field). The caret-resolver facet is deliberately NOT
 *  provided — the whole point is to run on `defaultCaretResolver`, the arm
 *  production uses. Caret parked at doc end so the line-level reveal is not
 *  already firing when the gesture starts. */
function mount(): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-table-drag-probe";
  parent.style.width = "600px";
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      // DOC has no CRLF, so string length IS Text length.
      selection: EditorSelection.cursor(DOC.length),
      extensions: [
        quollTheme,
        markdown({ base: markdownLanguage }),
        tableSkeletonField,
        tableBlockField,
      ],
    }),
    parent,
  });
}

function widgetRoot(v: EditorView): HTMLElement {
  const root = v.contentDOM.querySelector<HTMLElement>(".quoll-table-block");
  expect(root, "table widget must be rendered").not.toBeNull();
  return root as HTMLElement;
}

function cellByText(v: EditorView, text: string): HTMLElement {
  const cell = [...widgetRoot(v).querySelectorAll<HTMLElement>("th, td")].find(
    (c) => c.textContent === text
  );
  expect(cell, `cell "${text}" must be rendered`).toBeDefined();
  return cell as HTMLElement;
}

function firstText(cell: HTMLElement): Text {
  const node = cell.firstChild;
  expect(node?.nodeType, "cell renders its plain text as one text node").toBe(Node.TEXT_NODE);
  return node as Text;
}

/** Viewport point sitting in the LEFT QUARTER of character `index`'s box, so
 *  the browser's caret-from-point lands on the boundary BEFORE that character
 *  (a midpoint would be a coin-flip between `index` and `index + 1`).
 *  Measured with a Range because a character has no element of its own. */
function pointAtChar(cell: HTMLElement, index: number): { x: number; y: number } {
  const text = firstText(cell);
  const range = cell.ownerDocument.createRange();
  range.setStart(text, index);
  range.setEnd(text, index + 1);
  const box = range.getBoundingClientRect();
  expect(box.width, "character box must have real width (layout engine present)").toBeGreaterThan(
    2
  );
  return { x: box.left + box.width * 0.25, y: box.top + box.height / 2 };
}

/** Dispatch at the element ACTUALLY under the point (what a real pointer hits),
 *  bubbling up to the widget root's listeners. `detail: 1` because the drag
 *  path treats `detail === 0` as keyboard/programmatic and refuses it. */
function fire(type: "mousedown" | "mouseup" | "click", pt: { x: number; y: number }): void {
  const target = document.elementFromPoint(pt.x, pt.y);
  expect(target, `an element must sit at (${pt.x}, ${pt.y})`).not.toBeNull();
  (target as Element).dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      detail: 1,
      clientX: pt.x,
      clientY: pt.y,
    })
  );
}

/** The DOM selection a NATIVE drag leaves behind inside the widget — the thing
 *  CM's DOMObserver cannot map and reacts to by re-imposing `state.selection`.
 *  Installing it before the click is what makes the survival assertion real
 *  rather than a test of an idle observer. */
function selectAcross(from: HTMLElement, fromChar: number, to: HTMLElement, toChar: number): void {
  window.getSelection()?.setBaseAndExtent(firstText(from), fromChar, firstText(to), toChar);
}

/** Force the observer pass the widget's own DOM mutation would trigger, so the
 *  survival check is deterministic instead of frame-timing luck. `observer` is
 *  internal to EditorView, so assert it is really there — a rename upstream must
 *  fail loudly rather than silently vacate this pin. */
function flushObserver(v: EditorView): void {
  const observer = (v as unknown as { observer?: { flush?: () => void } }).observer;
  expect(typeof observer?.flush, "EditorView.observer.flush must exist").toBe("function");
  (observer as { flush: () => void }).flush();
}

/** Run a completed pointer gesture: press at `down`, leave the native-style DOM
 *  selection behind, release at `up`. Returns after the observer has run. */
async function drag(
  v: EditorView,
  down: { x: number; y: number },
  up: { x: number; y: number },
  leaveSelection: () => void
): Promise<void> {
  fire("mousedown", down);
  leaveSelection();
  fire("mouseup", up);
  fire("click", up);
  flushObserver(v);
  await settled();
  flushObserver(v);
}

/** Reveal fired: the widget was dropped and the raw source is back on screen. */
function revealed(v: EditorView): boolean {
  return (
    v.contentDOM.querySelector(".quoll-table-block") === null &&
    (v.contentDOM.textContent ?? "").includes("| gamma | delta |")
  );
}

describe("table drag selection — real EditorView, real pointer coordinates", () => {
  it("a drag across characters inside one cell lands a non-empty range and reveals the source", async () => {
    view = mount();
    await settled();
    view.focus();
    const cell = cellByText(view, "gamma");
    await drag(view, pointAtChar(cell, 1), pointAtChar(cell, 4), () =>
      selectAcross(cell, 1, cell, 4)
    );

    const sel = view.state.selection.main;
    expect(sel.empty, "drag must land a RANGE, not a caret").toBe(false);
    expect(sel.anchor).toBe(GAMMA + 1);
    expect(sel.head).toBe(GAMMA + 4);
    expect(revealed(view), "the dispatched range fires the line-level reveal").toBe(true);
  });

  it("a drag from one cell into the next spans both cells' source offsets", async () => {
    view = mount();
    await settled();
    view.focus();
    const from = cellByText(view, "gamma");
    const to = cellByText(view, "delta");
    await drag(view, pointAtChar(from, 1), pointAtChar(to, 3), () => selectAcross(from, 1, to, 3));

    const sel = view.state.selection.main;
    expect(sel.empty).toBe(false);
    expect(sel.anchor).toBe(GAMMA + 1);
    expect(sel.head).toBe(DELTA + 3);
    expect(sel.head, "range crosses the cell boundary").toBeGreaterThan(GAMMA + "gamma".length);
    expect(revealed(view)).toBe(true);
  });

  it("the dispatched range outlives further observer flushes and frames", async () => {
    view = mount();
    await settled();
    view.focus();
    const from = cellByText(view, "gamma");
    const to = cellByText(view, "delta");
    await drag(view, pointAtChar(from, 1), pointAtChar(to, 3), () => selectAcross(from, 1, to, 3));
    const after = view.state.selection.main;

    // The reveal detached the nodes the stale DOM selection pointed at; keep
    // pumping the observer that cell-point.ts blames for eating selections.
    for (let i = 0; i < 3; i++) {
      flushObserver(view);
      await settled();
    }
    expect(view.state.selection.main.anchor).toBe(after.anchor);
    expect(view.state.selection.main.head).toBe(after.head);
    expect(view.state.selection.main.empty).toBe(false);
  });

  it("the observer really is hostile: an unaccompanied widget-internal DOM selection IS destroyed", async () => {
    // Companion pin for the survival test above — without it, "the range
    // survived a flush" could just mean the observer never does anything here.
    // Same hostile DOM selection, NO widget dispatch: CM maps nothing, decides
    // it is out of sync and collapses to a single position (measured: the
    // table block start, which then reveals). This is cell-point.ts's stated
    // reason for mapping coordinates instead of reading window.getSelection().
    view = mount();
    await settled();
    view.focus();
    const from = cellByText(view, "gamma");
    const to = cellByText(view, "delta");
    selectAcross(from, 1, to, 3);
    expect(window.getSelection()?.toString(), "a real DOM range exists first").not.toBe("");

    flushObserver(view);
    await settled();
    const sel = view.state.selection.main;
    expect(sel.empty, "the observer collapses what it cannot map").toBe(true);
    expect(sel.anchor, "and it does not leave the caret where it was").not.toBe(DOC.length);
  });

  it("a press and release at the SAME point stays a click: collapsed caret at the cell start", async () => {
    // Non-vacuity control for the three above: the range they assert comes from
    // pointer TRAVEL (DRAG_THRESHOLD_PX), not from any click reaching the root.
    view = mount();
    await settled();
    view.focus();
    const cell = cellByText(view, "gamma");
    const pt = pointAtChar(cell, 2);
    await drag(view, pt, pt, () => selectAcross(cell, 2, cell, 2));

    const sel = view.state.selection.main;
    expect(sel.empty, "no travel → caret, not range").toBe(true);
    expect(sel.anchor).toBe(GAMMA);
    expect(revealed(view), "the caret still reveals the table source").toBe(true);
  });
});
