// Real-browser gate for table-cell DRAG selection (C6b, table-widget.ts +
// cell-point.ts) — the GESTURE half. The design premise these contracts rest on
// (a DOM selection made inside the widget does not survive CodeMirror's
// observer, so the widget must map pointer COORDINATES rather than read
// `window.getSelection()`) is pinned separately in
// table-drag-observer.browser.test.ts.
//
// Why this suite exists: every drag test in test/webview/table/ drives the
// widget with hand-built `new MouseEvent(...)` on a hand-built DOM and a
// SCRIPTED CaretResolver, so none of them observes what a real pointer gesture
// does. Here the input is TRUSTED — Playwright drives the browser's own
// mousedown / mousemove / mouseup / click through
// `userEvent.dragAndDrop` / `userEvent.click` — over REAL geometry: character
// rectangles measured with a DOM Range, and the facet's real caret-from-point
// resolvers.
//
// Both caret-from-point arms run, because there are two floor-dependent ones
// (see `ARMS` below), not one.
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollTableCaretResolver } from "../../src/webview/cm/table/cell-point.js";
import { settled } from "./helpers/frames.js";
import {
  BOLD_FROM,
  cellByText,
  clickPointer,
  DELTA,
  dragPointer,
  GAMMA,
  legacyCaretResolver,
  mount,
  PLAIN,
  pointAtChar,
  pointInWidgetPadding,
  proseLine,
  revealed,
  TABLE_BLOCK_START,
  TAIL,
  unmount,
  widgetRoot,
} from "./helpers/table-drag-harness.js";

let view: EditorView | undefined;
afterEach(() => {
  unmount(view);
  view = undefined;
});

/** `defaultCaretResolver` prefers `caretPositionFromPoint` and only falls back
 *  to `caretRangeFromPoint` where the former is missing — which is the
 *  extension's own floor (`engines.vscode ^1.94` = Chromium 124;
 *  `caretPositionFromPoint` shipped in Chrome 128). Playwright's bundled
 *  Chromium is far past 128, so running the default alone would leave the arm
 *  that is LIVE on the floor with zero real-geometry coverage. Every contract
 *  below therefore runs twice, once per arm, with identical assertions: the
 *  mapping is the widget's, not the API's. */
const ARMS: readonly (readonly [string, Extension])[] = [
  ["defaultCaretResolver (caretPositionFromPoint)", []],
  [
    "caretRangeFromPoint fallback (Chromium 124 floor)",
    quollTableCaretResolver.of(legacyCaretResolver),
  ],
];

describe.each(ARMS)("table drag selection — trusted pointer, %s", (_name, arm) => {
  // No `view.focus()` anywhere in this describe: a trusted mousedown moves
  // focus into CodeMirror's contenteditable by its own native default (the
  // reason table-widget.ts deliberately does NOT preventDefault it), and the
  // dedicated focus test at the bottom of the file pins exactly that. Calling
  // `focus()` first would hide a regression that broke it.

  it("a drag across characters inside one cell lands a non-empty range and reveals the source", async () => {
    view = mount(arm);
    await settled();
    const cell = cellByText(view, "gamma");
    await dragPointer(cell, pointAtChar(cell, 1), cell, pointAtChar(cell, 4));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.empty, "drag must land a RANGE, not a caret").toBe(false);
    expect(sel.anchor).toBe(GAMMA + 1);
    expect(sel.head).toBe(GAMMA + 4);
    expect(revealed(view), "the dispatched range fires the line-level reveal").toBe(true);
  });

  it("a drag from one cell into the next spans both cells' source offsets", async () => {
    view = mount(arm);
    await settled();
    const from = cellByText(view, "gamma");
    const to = cellByText(view, "delta");
    await dragPointer(from, pointAtChar(from, 1), to, pointAtChar(to, 3));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.empty).toBe(false);
    expect(sel.anchor).toBe(GAMMA + 1);
    expect(sel.head).toBe(DELTA + 3);
    expect(sel.head, "range crosses the cell boundary").toBeGreaterThan(GAMMA + "gamma".length);
    expect(revealed(view)).toBe(true);
  });

  it("a BACKWARD drag keeps the anchor at the press point", async () => {
    // `dragRange` names the press point `anchor` and the release point `head`
    // unconditionally — that identity is what lets a post-reveal Shift+Arrow
    // keep extending from where the user pressed. A "tidying" regression to
    // `{anchor: min, head: max}`, or an inverted `forward` computation, is
    // invisible to every forward-only drag above.
    view = mount(arm);
    await settled();
    const from = cellByText(view, "delta");
    const to = cellByText(view, "gamma");
    await dragPointer(from, pointAtChar(from, 3), to, pointAtChar(to, 1));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.anchor, "anchor stays where the pointer went DOWN").toBe(DELTA + 3);
    expect(sel.head).toBe(GAMMA + 1);
    expect(sel.anchor, "a backward drag really is backward").toBeGreaterThan(sel.head);
  });

  it("a drag out of a marked-up cell resolves its edge boundary to the construct edge", async () => {
    // `**bo**` is 6 source bytes rendered as 2 characters. The press lands on
    // the boundary BEFORE the first rendered character, which the cell's source
    // map expands over the `**` opener to the cell's content start — the same
    // number the old length-equality gate produced by snapping outward, now
    // reached by mapping rather than by giving up. The release end in a plain
    // cell keeps its exact offset. Those two numbers cannot be produced by any
    // other mechanism: a native CodeMirror drag over revealed source would land
    // on whatever character the pointer was over, never on this cell's content
    // start. So this case is also what makes the suite discriminate WHICH code
    // path produced the offsets, not merely that some plausible range appeared.
    view = mount(arm);
    await settled();
    const from = cellByText(view, "bo");
    const to = cellByText(view, "plain");
    await dragPointer(from, pointAtChar(from, 0), to, pointAtChar(to, 3));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.anchor, "the leading boundary expands over the `**` opener").toBe(BOLD_FROM);
    expect(sel.head, "the plain release end stays exact").toBe(PLAIN + 3);
    expect(revealed(view)).toBe(true);
  });

  it("a drag INSIDE `**bo**` lands exact source offsets past the delimiters", async () => {
    // The one assertion that proves Chromium's real caret-from-point +
    // `Range.toString()` ordering agrees with the map the renderer built: a
    // rendered offset measured over `<strong>bo</strong>` in a real layout
    // engine must come back as `**b|o**`, i.e. BOLD_FROM + 3. Every happy-dom
    // test feeds the resolver a hand-picked DOM position instead, so none of
    // them can observe this. A regression to the old whole-cell behaviour would
    // land BOLD_FROM + 6 here.
    view = mount(arm);
    await settled();
    const cell = cellByText(view, "bo");
    await dragPointer(cell, pointAtChar(cell, 0), cell, pointAtChar(cell, 1));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.empty, "drag must land a RANGE, not a caret").toBe(false);
    expect(sel.anchor).toBe(BOLD_FROM);
    expect(sel.head, "inside the cell, past the `**` opener").toBe(BOLD_FROM + 3);
    expect(revealed(view)).toBe(true);
  });

  it("a drag released in the widget's own padding does NOT snap into a nearby cell", async () => {
    // `cellPointAt` gates every endpoint through `closest("th, td")`, so a
    // release on the widget's padding has no cell and the whole drag is
    // refused — the click handler falls back to the block-start caret.
    // MEASURED, not assumed: Chromium's caret-from-point does return a text
    // position for a point in the padding, and the `closest` gate is the only
    // thing standing between that and a range the pointer never drew. This is
    // the current behaviour and the reason it is the right one: a half-drawn
    // range is a worse answer than the caret the user would have got from a
    // plain click on the same spot.
    view = mount(arm);
    await settled();
    const cell = cellByText(view, "gamma");
    const root = widgetRoot(view);
    const release = pointInWidgetPadding(root);
    await dragPointer(cell, pointAtChar(cell, 1), root, release);
    await settled();

    const sel = view.state.selection.main;
    expect(sel.empty, "no cell under the release point → no range").toBe(true);
    expect(sel.anchor, "falls back to the block-start caret").toBe(TABLE_BLOCK_START);
    expect(revealed(view), "the fallback caret still reveals this table").toBe(true);
  });

  it("a drag from a cell RELEASED over the paragraph below spans from the cell into the prose", async () => {
    // The gesture that was silently lost. Measured before the fix: the release
    // lands on a `.cm-line`, the click is retargeted to `.cm-content` so the
    // root's click listener never runs, and CodeMirror's own observer parks a
    // COLLAPSED CARET at the release position. That last detail is why the
    // emptiness assertion comes first: today's caret already sits at TAIL + 2,
    // so asserting the head alone would pass without the seam existing.
    view = mount(arm);
    await settled();
    const cell = cellByText(view, "gamma");
    const tail = proseLine(view, "tail");
    await dragPointer(cell, pointAtChar(cell, 1), tail, pointAtChar(tail, 2));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.empty, "the gesture must land a RANGE, not the caret it lands today").toBe(false);
    expect(sel.anchor, "anchor is the pressed cell's source offset").toBe(GAMMA + 1);
    expect(sel.head, "head is the release position in the prose below").toBe(TAIL + 2);
    expect(revealed(view), "and the range still fires the table's reveal").toBe(true);
  });

  it("a drag released BELOW the last line runs to the end of the document", async () => {
    // The commonest live overshoot, and the one the unit suite cannot see:
    // `posAtCoords` clamps a point past the document to `doc.length` rather than
    // answering null (@codemirror/view 6.43.0), so this is a real range, not a
    // degrade. Released well below the editor's own box.
    view = mount(arm);
    await settled();
    const cell = cellByText(view, "gamma");
    const box = view.dom.getBoundingClientRect();
    await dragPointer(cell, pointAtChar(cell, 1), document.body, {
      x: box.left + box.width / 2,
      y: box.bottom + 40,
    });
    await settled();

    const sel = view.state.selection.main;
    expect(sel.anchor).toBe(GAMMA + 1);
    expect(sel.head, "clamped to the document end, not refused").toBe(view.state.doc.length);
  });

  it("a press and release at the SAME point stays a click: collapsed caret at the cell start", async () => {
    // Non-vacuity control for every drag above: the ranges they assert come
    // from pointer TRAVEL past DRAG_THRESHOLD_PX, not from any click reaching
    // the root. The caret lands on the cell's CONTENT start (the historical
    // click semantics), not on the character under the pointer.
    view = mount(arm);
    await settled();
    const cell = cellByText(view, "gamma");
    await clickPointer(cell, pointAtChar(cell, 2));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.empty, "no travel → caret, not range").toBe(true);
    expect(sel.anchor).toBe(GAMMA);
    expect(revealed(view), "the caret still reveals the table source").toBe(true);
  });
});

describe("table drag selection — focus", () => {
  it("a trusted click inside a cell moves focus into the editor by the native mousedown default", async () => {
    // table-widget.ts stakes first-click behaviour on NOT preventDefault-ing
    // mousedown: "the native mousedown default is what moves focus into
    // CodeMirror's contenteditable, and without focus the revealed selection
    // would neither paint nor be extendable". Only a trusted press can show
    // that — a synthetic MouseEvent has no default action to run — so this is
    // the one contract that was unobservable before the suite went trusted.
    view = mount();
    await settled();
    expect(view.hasFocus, "nothing has focused the editor yet").toBe(false);

    const cell = cellByText(view, "gamma");
    await clickPointer(cell, pointAtChar(cell, 2));
    await settled();

    expect(view.hasFocus, "the native mousedown default moved focus in").toBe(true);
    expect(view.state.selection.main.anchor).toBe(GAMMA);
  });
});
