// @vitest-environment happy-dom
// The pointer-drag path: a mousedown/click pair inside a rendered table maps
// to a source RANGE, degrades to a whole-cell snap where the render carries no
// exact mapping, and stands down for the modifier-link and non-gesture cases.
// The collapsed-caret path is cm-table-widget-caret.test.ts. Fixtures — the
// scripted caret resolver in particular, whose private mount-scoped root is
// what keeps these tests from passing vacuously — are helpers/widget-fixtures.ts.
import { describe, expect, it } from "vitest";

import { parseTable } from "../../../src/markdown/table/index.js";
import { quollOpenExternalSink } from "../../../src/webview/cm/open-external.js";
import { TableBlockWidget } from "../../../src/webview/cm/table/table-widget.js";
import {
  IMG_CELL,
  MIXED_IMG_CELL,
  makeWidget,
  press,
  SRC,
  stubViewWithCaret,
} from "./helpers/widget-fixtures.js";

describe("TableBlockWidget drag-selection", () => {
  it("a drag across characters inside one cell dispatches a NON-EMPTY range at the source offsets", () => {
    const base = SRC.indexOf("alpha");
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    expect(dispatched).toEqual([{ selection: { anchor: base + 2, head: base + 5 } }]);
  });

  it("a backwards drag keeps its direction (anchor after head)", () => {
    const base = SRC.indexOf("alpha");
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 4 },
      { text: "alpha", offset: 1 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 60, 10);
    press(td, "click", 10, 10);
    expect(dispatched).toEqual([{ selection: { anchor: base + 4, head: base + 1 } }]);
  });

  it("a drag across two cells spans both cells' source offsets", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 1 },
      { text: "admin", offset: 3 },
    ]);
    const dom = mount(makeWidget(SRC));
    const cells = dom.querySelectorAll("td");
    press(cells[0] as HTMLElement, "mousedown", 10, 10);
    press(cells[1] as HTMLElement, "click", 200, 10);
    expect(dispatched).toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 1, head: SRC.indexOf("admin") + 3 } },
    ]);
  });

  // The behaviour change this PR is for. UNTIL the cell source map existed this
  // dispatched the WHOLE cell (`**bold**`), because the length-equality gate
  // reported `offset: null` for any cell holding inline markup. Now the map
  // places both ends inside the delimiters: rendered "b|ol|d" is source
  // `**b|ol|d**`, so the drag selects exactly the characters it crossed.
  it("a drag inside a `**bold**` cell selects the crossed characters, not the whole cell", () => {
    const src = "| Name |\n| - |\n| **bold** |";
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "bold", offset: 1 },
      { text: "bold", offset: 3 },
    ]);
    const dom = mount(makeWidget(src));
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    const from = src.indexOf("**bold**");
    expect(dispatched).toEqual([{ selection: { anchor: from + 3, head: from + 5 } }]);
  });

  // An NBSP inside a cell is CONTENT — the parser's cell trimming is ASCII
  // space/tab only, so the stamps bracket it. Rendering `cell.raw.trim()` would
  // strip it (JS `trim()` takes every Unicode space), leaving the render one
  // character short of what the stamps describe and every offset in the cell
  // off by one. That mismatch fails the map's staleness check, so the whole
  // gesture would degrade to the whole-cell snap.
  it("a drag inside an NBSP-padded cell maps exactly (anchoring at cellFrom)", () => {
    const src = "| Name |\n| - |\n| \u00a0xy |";
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "\u00a0xy", offset: 1 },
      { text: "\u00a0xy", offset: 3 },
    ]);
    const dom = mount(makeWidget(src));
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    const from = src.indexOf("\u00a0xy");
    expect(dispatched).toEqual([{ selection: { anchor: from + 1, head: from + 3 } }]);
  });

  // Regression pin (Fable 95 / Codex 100): the DRAG_THRESHOLD_PX gate returns
  // before either endpoint is resolved, so a click that did not move dispatches
  // the collapsed caret NO MATTER what the two endpoints would have mapped to.
  //
  // The cell is the IMAGE one, and that is the whole point. With `**bold**`
  // (this row's fixture until the source map landed) both endpoints now map to
  // the SAME source offset, so `dragRange`'s own collapse guard answers the
  // caret too and deleting the threshold left the row green — it pinned
  // nothing. Beside a live image both endpoints are unmappable, so without the
  // gate this gesture snaps outward to the WHOLE CELL, which is the answer a
  // 0px click must never produce.
  it("a PLAIN CLICK on an unmappable cell still dispatches the collapsed caret", () => {
    const src = `| A |\n| - |\n| ${IMG_CELL} |`;
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "b", offset: 0 }, // mousedown at the image junction (unmappable)
      { text: "b", offset: 0 }, // click without moving — the same junction
    ]);
    const dom = mount(makeWidget(src));
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 30, 10);
    press(td, "click", 30, 10);
    expect(dispatched).toEqual([{ selection: { anchor: src.indexOf(IMG_CELL) } }]);
  });

  // The collapse arm of the same-cell branch. The plain-click row above cannot
  // reach it: at 0px travel `dragRange` returns at the DRAG_THRESHOLD_PX gate
  // before either endpoint is resolved. Here the pointer moves 50px and BOTH
  // ends still resolve to the same source offset (rendered index 2 of `bold` is
  // source index 4 either way), which is the only way in. Without the collapse
  // check the widget dispatches `{ anchor: X, head: X }` — a zero-width range at
  // the POINTER — where the caret belongs at the cell's CONTENT START.
  it("a same-cell drag whose ends resolve to the SAME offset falls back to the cell-start caret", () => {
    const src = "| Name |\n| - |\n| **bold** |";
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "bold", offset: 2 },
      { text: "bold", offset: 2 },
    ]);
    const dom = mount(makeWidget(src));
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10); // ABOVE the threshold — unlike the plain click
    expect(dispatched).toEqual([{ selection: { anchor: src.indexOf("**bold**") } }]);
  });

  // Fable 90 / Codex 98: direction must come from cell order, not from an
  // offset compared against a 0 sentinel.
  //
  // The unmappable endpoint is now an IMAGE cell, not `**b**`: since the source
  // map landed, `**b**` maps exactly and would no longer reach the snap. A live
  // image renders zero characters, so the boundary between the `a` and `b` text
  // runs measures the same rendered offset on both sides of it and stays the
  // one thing a rendered offset cannot resolve.
  it("a backwards drag OUT of an unmappable cell covers both cells", () => {
    const src = `| A | B |\n| - | - |\n| q | ${IMG_CELL} |`;
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "b", offset: 0 }, // mousedown at the image junction (unmappable)
      { text: "q", offset: 0 }, // drag left into the plain `q` cell
    ]);
    const dom = mount(makeWidget(src));
    const cells = dom.querySelectorAll("td");
    press(cells[1] as HTMLElement, "mousedown", 200, 10);
    press(cells[0] as HTMLElement, "click", 10, 10);
    // Anchor snaps OUTWARD to the end of the image cell, head is exact in `q`.
    expect(dispatched).toEqual([
      {
        selection: {
          anchor: src.indexOf(IMG_CELL) + IMG_CELL.length,
          head: src.indexOf("| q |") + 2,
        },
      },
    ]);
  });

  it("a plain click (no movement) still dispatches the collapsed caret at the cell start", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 3 },
      { text: "alpha", offset: 3 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 10);
    press(td, "click", 31, 10); // sub-threshold jitter
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  it("a click with no preceding mousedown still dispatches the collapsed caret", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 4 }]);
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "click", 60, 10);
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  it("mousedown alone dispatches NOTHING (no reveal mid-drag)", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 2 }]);
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 10, 10);
    expect(dispatched).toEqual([]);
  });

  it("ignores a non-primary-button mousedown", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10, { button: 2 }); // right-click
    press(td, "click", 60, 10);
    // No anchor was captured, so this is the plain-caret path.
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  // Fable 85 / Codex 95: the anchor must be consumed even on the modifier-click
  // early return, or it leaks into the NEXT gesture.
  it("a modifier-click clears the pending anchor (no leak into the next click)", () => {
    const src = "| L |\n| - |\n| [x](https://example.com) |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    // The resolver MUST resolve inside a real cell so the mousedown arms a
    // NON-null point. An earlier version of this test resolved to
    // `document.body`, which the containment gate rejects — `pending.point`
    // was then null, the leak path short-circuited to the very caret dispatch
    // the assertion expects, and the test stayed green WITH the leak present.
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "x", offset: 0 }],
      [quollOpenExternalSink.of((href: string) => opened.push(href))]
    );
    const dom = mount(makeWidget(src));
    const a = dom.querySelector("a") as HTMLElement;
    press(a, "mousedown", 10, 10);
    press(a, "click", 10, 10, { metaKey: true });
    expect(opened).toEqual(["https://example.com"]);
    expect(dispatched).toEqual([]);
    // The NEXT click, far away and with no mousedown of its own, must not
    // resurrect the cleared anchor. If it leaked, this click sees moved=true
    // with a non-null point (link cell → offset null → whole-cell snap) and
    // dispatches a RANGE spanning the cell instead of the caret below.
    press(dom.querySelector("td") as HTMLElement, "click", 400, 10);
    expect(dispatched).toEqual([
      { selection: { anchor: src.indexOf("[x](https://example.com)") } },
    ]);
  });

  // error-handler 92: a doc edit landing mid-gesture moves the stamps.
  it("updateDOM cancels an in-flight drag (stale-offset guard)", () => {
    // Control arm FIRST. The real assertion below is a NEGATIVE one (expects a
    // caret), so anything that quietly stops the resolver from resolving —
    // a renamed fixture text, a rescoped walker — would produce the same
    // expected value and the test would keep passing while pinning nothing.
    // Proving the identical gesture DOES produce a range means the caret can
    // only come from pendingDrag.delete().
    const control: unknown[] = [];
    const { mount: controlMount } = stubViewWithCaret(control, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const controlDom = controlMount(makeWidget(SRC));
    const controlTd = controlDom.querySelectorAll("td")[0] as HTMLElement;
    press(controlTd, "mousedown", 10, 10);
    press(controlTd, "click", 60, 10);
    expect(control).toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: SRC.indexOf("alpha") + 5 } },
    ]);

    const dispatched: unknown[] = [];
    const { mount, update } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const first = new TableBlockWidget(parseTable(SRC, 0, SRC.length)!, SRC, 0, 0);
    const dom = mount(first);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    // A distant edit shifts this table while the button is still down.
    const shifted = new TableBlockWidget(parseTable(SRC, 0, SRC.length)!, SRC, 5, 5);
    update(dom, shifted, first);
    press(td, "click", 60, 10);
    // The anchor was invalidated → collapsed caret at the NEW stamp, not a
    // range built from two different coordinate systems.
    expect(dispatched).toEqual([{ selection: { anchor: 5 + SRC.indexOf("alpha") } }]);
  });

  // The counterpart of the row above: the shift lands BEFORE the gesture, not
  // during it, and the drag must still map exactly. This is the ONE reason the
  // source map holds CELL-RELATIVE offsets (see the CELL-CONTENT-RELATIVE
  // paragraph on `CellSourceRun`, cell-source-map.ts) — `stampRow` re-points
  // the stamps on a pure positional shift WITHOUT re-rendering, so an absolute
  // map would go stale exactly here and every marked-up cell would silently
  // degrade to the whole-cell snap after the first keystroke above a table.
  // The other shift rows (cm-table-widget-update.test.ts's re-stamp pair, and
  // the click-after-shift row in cm-table-widget-render.test.ts) assert stamps
  // on a PLAIN-TEXT cell and never drag afterwards, so they cannot see it.
  it("a drag in a marked-up cell still maps exactly after a pure positional shift", () => {
    const src = "| Name |\n| - |\n| **bold** |";
    const dispatched: unknown[] = [];
    const { mount, update } = stubViewWithCaret(dispatched, [
      { text: "bold", offset: 1 },
      { text: "bold", offset: 3 },
    ]);
    const first = new TableBlockWidget(parseTable(src, 0, src.length)!, src, 0, 0);
    const dom = mount(first);
    // Distant insertion above the table: same bytes, new base → stampRow path.
    const shifted = new TableBlockWidget(parseTable(src, 0, src.length)!, src, 5, 5);
    expect(update(dom, shifted, first)).toBe(true);

    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    const from = 5 + src.indexOf("**bold**");
    expect(dispatched).toEqual([{ selection: { anchor: from + 3, head: from + 5 } }]);
  });

  // The native mousedown default is what moves focus into CodeMirror's
  // contenteditable; without focus the revealed selection neither paints nor
  // extends. Adding `event.preventDefault()` here is the natural "stop the
  // flicker" change, so the invariant needs its own assertion.
  it("mousedown is NOT preventDefault'ed (the native default is what focuses the editor)", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 2 }]);
    const dom = mount(makeWidget(SRC));
    const event = press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 10, 10);
    expect(event.defaultPrevented).toBe(false);
  });

  // Mirror of "a backwards drag OUT of an unmappable cell": there the ANCHOR is
  // unmappable, here the HEAD is. Without this the backwards arm of
  // `head.offset ?? (forward ? head.cellTo : head.cellFrom)` is never taken.
  it("a backwards drag ENDING in an unmappable cell snaps the head OUTWARD", () => {
    const src = `| A | B |\n| - | - |\n| ${IMG_CELL} | q |`;
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "q", offset: 1 }, // mousedown in the plain `q` cell (mappable)
      { text: "b", offset: 0 }, // drag LEFT to the image junction (unmappable)
    ]);
    const dom = mount(makeWidget(src));
    const cells = dom.querySelectorAll("td");
    press(cells[1] as HTMLElement, "mousedown", 200, 10);
    press(cells[0] as HTMLElement, "click", 10, 10);
    // Head snaps to the image cell's START — outward for a backwards drag, so
    // the range still covers the cell the pointer crossed.
    expect(dispatched).toEqual([
      { selection: { anchor: src.indexOf("| q |") + 3, head: src.indexOf(IMG_CELL) } },
    ]);
  });

  // Recorded decision, not an accident (Codex round-3, 99). Codex asked that a
  // same-cell drag with BOTH ends unmappable fail closed to the collapsed caret
  // so a 4px wiggle beside an image cannot select the cell. Declined here: the
  // whole-cell range is the EXISTING contract (this PR narrows what reaches it
  // from "every cell holding inline markup" to "cells holding a construct that
  // renders no text"), and flipping it is a decision about DRAG_THRESHOLD_PX
  // semantics rather than about source-span mapping. Pinned so a future PR that
  // prefers the caret has a test to flip.
  it("a drag whose BOTH ends sit at an in-cell image junction dispatches the whole cell", () => {
    const src = `| A |\n| - |\n| ${IMG_CELL} |`;
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "b", offset: 0 },
      { text: "b", offset: 0 },
    ]);
    const dom = mount(makeWidget(src));
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10); // past DRAG_THRESHOLD_PX
    const from = src.indexOf(IMG_CELL);
    expect(dispatched).toEqual([{ selection: { anchor: from, head: from + IMG_CELL.length } }]);
  });

  // The MIXED same-cell case, which only became reachable when the gate moved
  // from per-CELL to per-BOUNDARY: one end exact, the other beside the image.
  // The forced `forward = true` this replaced answered a range on the side the
  // pointer never crossed — pressing between `e` and `f` and dragging LEFT
  // dispatched the single character `f`, to the RIGHT of the press point. A
  // rendered offset beside an invisible construct measures the same on both
  // sides of it, so neither end can supply the direction: fail closed to the
  // whole cell (same answer as the BOTH-unmappable row above).
  it.each([
    ["RIGHT", { text: "abc", offset: 1 }, { text: "def", offset: 0 }],
    ["LEFT", { text: "def", offset: 2 }, { text: "abc", offset: 3 }],
  ])("a same-cell drag %s between an exact boundary and an image junction covers the whole cell", (_direction, down, up) => {
    const src = `| A |\n| - |\n| ${MIXED_IMG_CELL} |`;
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [down, up]);
    const dom = mount(makeWidget(src));
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    const from = src.indexOf(MIXED_IMG_CELL);
    expect(dispatched).toEqual([
      { selection: { anchor: from, head: from + MIXED_IMG_CELL.length } },
    ]);
  });

  // The other unmappable arm: a cell whose DOM no longer matches the map that
  // was registered for it. `renderCellInto` is the ONLY thing that registers a
  // map, so anything that fills a cell some other way — or mutates it
  // afterwards — must fall back rather than map through a description of
  // content that is no longer there.
  it("a drag in a cell whose DOM was replaced behind the map falls back to the whole cell", () => {
    const src = "| Name |\n| - |\n| **bold** |";
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "tampered", offset: 1 },
      { text: "tampered", offset: 3 },
    ]);
    const dom = mount(makeWidget(src));
    const td = dom.querySelector("td") as HTMLElement;
    td.replaceChildren(document.createTextNode("tampered"));
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    const from = src.indexOf("**bold**");
    expect(dispatched).toEqual([{ selection: { anchor: from, head: from + "**bold**".length } }]);
  });

  // The threshold's VALUE, its `>=` boundary, and the Manhattan metric are all
  // load-bearing and were previously unpinned: every drag test moved 50-190px
  // and every click test 0-1px, so any threshold in 2..50 passed the suite.
  it.each([
    [{ dx: 3, dy: 0 }, "caret"],
    [{ dx: 0, dy: 3 }, "caret"],
    [{ dx: 4, dy: 0 }, "range"], // exactly DRAG_THRESHOLD_PX → pins `>=`
    [{ dx: 2, dy: 2 }, "range"], // Manhattan sum, not Euclidean distance
  ] as const)("pointer travel %j resolves as a %s", ({ dx, dy }, kind) => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 30);
    press(td, "click", 30 + dx, 30 + dy);
    expect(dispatched).toEqual([
      kind === "caret"
        ? { selection: { anchor: SRC.indexOf("alpha") } }
        : { selection: { anchor: SRC.indexOf("alpha") + 2, head: SRC.indexOf("alpha") + 5 } },
    ]);
  });

  // (2) of the TODO entry. Travel was measured between two VIEWPORT points, so
  // a gesture the CONTENT moved under — a scroll mid-drag, a host-driven
  // scrollIntoView, CodeMirror's own scrolling — measured ~0 and was judged a
  // plain click. The pointer moved relative to the TEXT, which is the only
  // space the gesture means anything in.
  it("a drag the content scrolled under is a drag, even with a stationary pointer", () => {
    const dispatched: unknown[] = [];
    const { mount, scrollContentBy } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 30);
    scrollContentBy(0, 40); // the text moved 40px under a pointer that did not
    press(td, "click", 30, 30);
    expect(dispatched).toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: SRC.indexOf("alpha") + 5 } },
    ]);
  });

  // The mirror image, and the reason this is ONE measurement in the content's
  // frame rather than two gates added together: a pointer that follows the
  // scroll exactly has not moved over the text at all, so it is still a click.
  // A scroll-aware threshold that summed magnitudes would call this a drag.
  it("a pointer that tracks the scrolling content exactly is still a click", () => {
    const dispatched: unknown[] = [];
    const { mount, scrollContentBy } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 30);
    scrollContentBy(0, 40);
    press(td, "click", 30, -10); // followed the text up by exactly 40px
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  it("horizontal content movement counts too", () => {
    const dispatched: unknown[] = [];
    const { mount, scrollContentBy } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 30);
    scrollContentBy(25, 0);
    press(td, "click", 30, 30);
    expect(dispatched).toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: SRC.indexOf("alpha") + 5 } },
    ]);
  });

  // Aborted-gesture guard. A press released OUTSIDE the widget delivers no
  // click to the root, so the armed anchor survives with stale coordinates.
  // The only click that can then reach this handler without a mousedown of its
  // own is a keyboard/programmatic one — `detail === 0`, clientX/Y 0 — which
  // would otherwise read a huge bogus travel and dispatch a range the user
  // never drew. It must take the caret path instead.
  it("a detail-0 click (keyboard / programmatic) never takes the drag path", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10, { detail: 0 });
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  // The guard above lives INSIDE dragRange, i.e. BELOW the click handler's
  // modifier-link branch. That placement matters: keyboard activation of a
  // focused in-cell link (Enter with Cmd held) carries detail 0, so hoisting
  // the guard to the top of the click listener — which reads as a gesture
  // precondition and so looks like a natural simplification — would make
  // Cmd+Enter on a link do nothing.
  //
  // This test is deliberately explicit about that, but it is NOT the only
  // thing standing in the way: the hoist was measured, and it reddens 14 tests,
  // 13 of which live in the sibling widget suites and predate the drag work.
  // happy-dom's `.click()` and hand-built `MouseEvent`s both default to detail
  // 0, so every programmatic caret test and all four modifier-link sink tests
  // already fail on it. Do not "strengthen" this by claiming the guard is
  // otherwise unprotected — that claim was made here once and was false.
  it("a detail-0 modifier click on an <a> still opens the link (the guard sits BELOW the link branch)", () => {
    const src = "| L |\n| - |\n| [x](https://example.com) |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "x", offset: 0 }],
      [quollOpenExternalSink.of((href: string) => opened.push(href))]
    );
    const dom = mount(makeWidget(src));
    const a = dom.querySelector("a") as HTMLElement;
    // Keyboard activation: no pointer gesture, so no mousedown and clientX/Y 0.
    const event = press(a, "click", 0, 0, { detail: 0, metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://example.com"]);
    expect(dispatched).toEqual([]);
  });
});
