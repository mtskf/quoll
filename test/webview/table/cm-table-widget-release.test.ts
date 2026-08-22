// @vitest-environment happy-dom
// The OUTSIDE-RELEASE seam: a drag that starts in a rendered cell and is
// released outside the widget root. Per UI-events a `click` is delivered to the
// nearest common ancestor of the mousedown and mouseup targets — MEASURED in
// real Chromium, not inferred: the release lands on a `.cm-line` and the click
// on `.cm-content`, so the root's click listener never runs and the gesture was
// dispatched as nothing. table-widget.ts therefore also listens for `mouseup`
// on the document, and that listener dispatches ONLY when the release landed
// outside the root; an inside release is left to the click listener, which is
// where the modifier-click `open-external` path lives and stays.
//
// Four things disarm the seam, and each has a row below: the release itself,
// a native drag-and-drop, the widget's destruction, and the NEXT press
// anywhere. That last one is the load-bearing guard — see its row.
// The click-seam contract is cm-table-widget-drag.test.ts.
import { describe, expect, it, vi } from "vitest";

import { parseTable } from "../../../src/markdown/table/index.js";
import { quollOpenExternalSink } from "../../../src/webview/cm/open-external.js";
import { TableBlockWidget } from "../../../src/webview/cm/table/table-widget.js";
import { makeWidget, press, SRC, stubViewWithCaret } from "./helpers/widget-fixtures.js";

/** A document position in the prose BELOW the table, as `view.posAtCoords`
 *  would answer it. Any offset outside the table's own source works. */
const BELOW = 500;

describe("TableBlockWidget release outside the widget", () => {
  it("a drag released over the prose below dispatches cell-offset → release position", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    // Released on the BODY: no click is delivered to the widget root at all,
    // so without the mouseup seam this gesture dispatches nothing.
    press(document.body, "mouseup", 30, 400);
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") + 2, head: BELOW } }]);
  });

  it("a release INSIDE the widget dispatches nothing — the click seam owns it", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mount(makeWidget(SRC));
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 30);
    press(td, "mouseup", 80, 30);
    expect(dispatched, "the mouseup seam stands down").toEqual([]);
    press(td, "click", 80, 30);
    expect(dispatched, "and the click seam dispatches exactly once").toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: SRC.indexOf("alpha") + 5 } },
    ]);
  });

  // The Done-when's "modifier-click open-external path proven unchanged", as a
  // WHOLE gesture: press, release and click all on the link. The mouseup lands
  // inside the root, so the new seam must not consume the pending anchor, must
  // not dispatch, and must leave the click listener's link branch untouched.
  it("a modifier-click on an in-cell link still opens through the sink, mouseup and all", () => {
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
    press(a, "mousedown", 10, 10);
    press(a, "mouseup", 10, 10);
    const click = press(a, "click", 10, 10, { metaKey: true });
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://example.com"]);
    expect(dispatched).toEqual([]);
  });

  // ⚠️ The most important row in this file (Codex 94 / Fable 85 /
  // error-handler 83, independently).
  //
  // A release the webview's document never sees — the pointer leaves the
  // iframe, focus is lost, Cmd+Tab — leaves the listener armed. The user's NEXT
  // unrelated release would then be read as THIS gesture's end and dispatch a
  // range from a table cell to a point the user never dragged to: exactly the
  // "selection the user did not draw" the whole widget is built to refuse.
  //
  // The guard is a document-level `mousedown` disarm rather than a list of
  // `blur` / `visibilitychange` / `pointercancel` handlers, because a stray
  // mouseup is ALWAYS preceded by a mousedown. That makes the guard total: it
  // cannot be outrun by a focus-loss path nobody enumerated.
  it("a press elsewhere disarms a gesture whose release never arrived", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    // ...the mouseup goes to the workbench, outside this document. Later, an
    // ordinary unrelated click somewhere else in the editor:
    press(document.body, "mousedown", 500, 900);
    press(document.body, "mouseup", 500, 900);
    expect(dispatched, "the stale gesture must not be resurrected").toEqual([]);
  });

  // The far side of the one-shot row below: that row pins that a release with
  // no new press behind it dispatches nothing, and this one pins that a release
  // WITH one does. Together they are the whole cycle — arm, fire, re-arm — and
  // neither half implies the other.
  //
  // ⚠️ It replaces a row titled "the arming press does not disarm its own
  // gesture", which was byte-identical to the first row of this file. The
  // knowledge that row carried is worth keeping even though the row was not:
  // the arming mousedown BUBBLES to the document, so a bubble-phase disarm
  // would cancel the gesture it was just armed for, and every outside-release
  // row in this file would then go green for the wrong reason (nothing
  // dispatched, caret expected nowhere). The `down === armingPress` identity
  // check in table-widget.ts guards exactly that, and under the `capture: true`
  // this seam uses it is UNREACHABLE — the press has already passed the
  // document before the listener exists. So no row here can pin it, and the old
  // title claimed a pin that does not exist. (Measured: dropping the identity
  // check leaves the suite green.)
  //
  // ⚠️ What THIS row pins, stated honestly: the observable re-arm cycle, not
  // the `armedRelease.get(root)?.abort()` line that runs at arm time. That line
  // is unobservable here — gesture 1's controller was already aborted by its
  // own mouseup, so aborting it again is a no-op. No single-line mutation of
  // the seam was found that reddens this row (measured: dropping the arm-time
  // abort, dropping `armedRelease.set`, and dropping the mouseup's own
  // `release.abort()` all leave it green — the last two redden the destroy and
  // one-shot rows instead). It is a behavioural tripwire for the cycle, and the
  // scripted head makes it discriminating about WHICH gesture answered.
  it("a completed gesture re-arms: the next press draws its own range", () => {
    const dispatched: unknown[] = [];
    // The head is the release's own Y, so the two gestures cannot be confused
    // for one another: a second dispatch carrying the FIRST release's head
    // would mean the stale listener answered, not a freshly armed one.
    const { mount } = stubViewWithCaret(
      dispatched,
      [
        { text: "alpha", offset: 2 },
        { text: "alpha", offset: 2 },
      ],
      [],
      (_x, y) => y
    );
    const td = mount(makeWidget(SRC)).querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 30);
    press(document.body, "mouseup", 30, 400);
    press(td, "mousedown", 30, 30);
    press(document.body, "mouseup", 30, 600);
    expect(dispatched).toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: 400 } },
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: 600 } },
    ]);
  });

  // Fable 80. A right-button press-and-release while the left button is held
  // delivers a `button === 2` mouseup to the document. Consuming it would end
  // the gesture at the wrong point — and because the one-shot `abort()` runs
  // first, the real left release would then find no listener at all.
  it("a non-primary release is not the end of the gesture", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    press(document.body, "mouseup", 200, 200, { button: 2 });
    expect(dispatched, "the right-button release is ignored").toEqual([]);
    press(document.body, "mouseup", 30, 400);
    expect(dispatched, "and the real release still lands the range").toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: BELOW } },
    ]);
  });

  // The phase of the DISARM listener (the document `mousedown`), pinned. No
  // other row here distinguishes capture from bubble for it — they all disarm
  // through presses nothing interferes with. Its pair is the row below, which
  // pins the phase of the DISPATCH listener (the document `mouseup`); the two
  // read alike and are not interchangeable, so each names its listener.
  it("a press that stops propagation still disarms the seam", () => {
    // Sibling widgets in this editor — the task checkbox, the fenced-code copy
    // and collapse buttons, the language picker — all call stopPropagation() on
    // mousedown, and NONE of them stops mouseup. A bubble-phase disarm is
    // starved by exactly those presses while the release still arrives: the one
    // combination that dispatches a range the user never drew. Capture cannot be
    // starved from below. (Measured: bubble 0, capture 1, mouseup delivered.)
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    // ...the release was lost outside this document. Later, a press on a
    // sibling widget that swallows mousedown:
    const swallower = document.createElement("button");
    document.body.appendChild(swallower);
    swallower.addEventListener("mousedown", (event) => event.stopPropagation());
    press(swallower, "mousedown", 500, 900);
    press(document.body, "mouseup", 500, 900);
    expect(dispatched).toEqual([]);
  });

  // Every other disarm row presses on `document.body` or a bare `<button>` —
  // nodes that arm nothing. A document with two tables is ordinary, and the
  // disarming press is then itself an ARMING press for another widget, which is
  // the one shape none of those rows have.
  //
  // What that shape actually tests: `pendingDrag` and `armedRelease` are keyed
  // on the widget ROOT, so the first table's disarm must take its own entry and
  // only its own. Were either a module-wide singleton, the second table's press
  // would arm into the same slot the first one is about to clear, and the
  // second gesture — the live one, the one the user is making — would be the
  // casualty. (The ORDER is not what discriminates here: document capture runs
  // before the second root's bubble `mousedown`, but root-keying makes either
  // order correct. It is the keying that this row would lose.)
  //
  // The second table's range doubles as the control arm, in the idiom of
  // cm-table-widget-drag.test.ts's stale-offset row: the first expectation is
  // NEGATIVE, so without a positive one beside it anything that quietly stopped
  // both gestures from resolving would read as a pass.
  it("a press in ANOTHER table disarms this one and arms that one", () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    // ONE VEHICLE, ONE WIDGET (widget-fixtures.ts) — two tables need two.
    const { mount: mountFirst } = stubViewWithCaret(
      first,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const { mount: mountSecond } = stubViewWithCaret(
      second,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const firstTd = mountFirst(makeWidget(SRC)).querySelectorAll("td")[0] as HTMLElement;
    const secondTd = mountSecond(makeWidget(SRC)).querySelectorAll("td")[0] as HTMLElement;
    press(firstTd, "mousedown", 30, 30);
    // ...the first table's release was lost outside this document. The user
    // then starts a fresh drag in the SECOND table.
    press(secondTd, "mousedown", 30, 30);
    press(document.body, "mouseup", 30, 400);
    expect(first, "the stale gesture must not be resurrected").toEqual([]);
    expect(second, "and the live one must still draw its range").toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: BELOW } },
    ]);
  });

  // The phase of the DISPATCH listener (the document `mouseup`), pinned — the
  // pair of the disarm row above, and the only row that distinguishes capture
  // from bubble for it.
  //
  // No sibling widget stops `mouseup` today, which is exactly why this listener
  // was left in bubble; but that is an enumeration of today's siblings, and the
  // failure it admits is silent — a starved seam dispatches NOTHING, which is
  // indistinguishable from the pre-seam behaviour, so no other row would redden.
  // Capture runs document → target and cannot be starved from below.
  it("a sibling that stops mouseup does not starve the dispatch seam", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    // The drag ends over a sibling widget that swallows mouseup on its way up.
    const swallower = document.createElement("button");
    document.body.appendChild(swallower);
    swallower.addEventListener("mouseup", (event) => event.stopPropagation());
    press(swallower, "mouseup", 500, 900);
    expect(dispatched, "the release still reaches the seam").toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: BELOW } },
    ]);
  });

  it("a native drag-and-drop disarms the seam (no mouseup follows a dragstart)", () => {
    // MEASURED (2026-08-22): a plain cell drag fires no `dragstart` at all, so
    // this guard is for a press that starts on an in-cell <img> or <a>, both
    // natively draggable. A browser that starts a DnD delivers `dragend`, never
    // `mouseup`. Nothing here preventDefaults the drag — the seam simply stands
    // down, because a drag-and-drop is not a text selection.
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    document.body.dispatchEvent(new Event("dragstart", { bubbles: true }));
    press(document.body, "mouseup", 30, 400);
    expect(dispatched).toEqual([]);
  });

  it("destroying the widget disarms its gesture", () => {
    // `WidgetType.destroy` is CodeMirror's documented removal hook. Without the
    // override the closure keeps `root` alive and the listeners keep firing for
    // a widget the editor has already forgotten.
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const widget = makeWidget(SRC);
    const dom = mount(widget);
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    widget.destroy(dom); // still IN the document — so `isConnected` cannot mask this
    expect(dom.isConnected, "the guard under test is destroy(), not isConnected").toBe(true);
    press(document.body, "mouseup", 30, 400);
    expect(dispatched).toEqual([]);
  });

  it("a detached root's gesture dispatches nothing", () => {
    // CodeMirror rebuilds a widget by REPLACING its root, and the old root's
    // offsets stop tracking the document the moment it leaves it. On the click
    // seam that was self-enforcing — a detached root receives no clicks — but a
    // DOCUMENT-level listener still fires, so the guard has to be explicit.
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    dom.remove();
    press(document.body, "mouseup", 30, 400);
    expect(dispatched).toEqual([]);
  });

  it("the seam is one-shot: a second release dispatches nothing more", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    press(document.body, "mouseup", 30, 400);
    expect(dispatched).toHaveLength(1);
    press(document.body, "mouseup", 30, 400);
    expect(dispatched, "the listener left with the gesture").toHaveLength(1);
  });

  it("a sub-threshold release just outside the widget falls back to the cell caret", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 2 }]);
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    press(document.body, "mouseup", 31, 30); // 1px — a click that slipped off the edge
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  it("a release the editor cannot place falls back to the cell caret", () => {
    // `posAtCoords` answers null for a point it cannot resolve — an unrendered
    // block, a gap in the viewport. It does NOT answer null for an overshoot:
    // past the last line it clamps to `doc.length` (@codemirror/view 6.43.0),
    // which is why the browser suite pins the overshoot as a real RANGE and
    // this row scripts the null explicitly.
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 2 }], [], () => null);
    const dom = mount(makeWidget(SRC));
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    press(document.body, "mouseup", 30, 4000);
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  // The third catch in this widget family, and the last one to get a pin: the
  // siblings are `dispatchSelection`'s (cm-table-widget-caret.test.ts) and
  // `cellPointAt`'s (cm-table-cell-point.test.ts). This one is the only one
  // whose listener lives on the DOCUMENT, and the only one whose throw mode is
  // SYSTEMATIC rather than a teardown race: `posAtCoords` calls `readMeasured`,
  // which throws whenever CodeMirror is mid-update, and a DOM mouseup is
  // exactly what an in-progress update can deliver. Every such drag collapses
  // silently to a caret, so the log is the only trace it happened.
  //
  // `objectContaining` rather than an exact payload: what the log must carry is
  // an Error, and pinning the surrounding diagnostic fields exactly would make
  // this row a change-detector for a payload that is meant to grow.
  it("logs and swallows a throwing release lookup instead of losing the editor", () => {
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 2 }], [], () => {
      throw new Error("posAtCoords boom");
    });
    const dom = mount(makeWidget(SRC));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
      expect(() => press(document.body, "mouseup", 30, 400)).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(
        "[quoll] table widget release lookup failed",
        expect.objectContaining({ err: expect.any(Error) })
      );
    } finally {
      consoleError.mockRestore();
    }
    // The gesture costs itself, not the editor: the same collapsed caret the
    // null-lookup row above degrades to.
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  it("a press on the widget's own padding falls back to the block-start caret", () => {
    // No cell under the press, so there is no anchor to span FROM: `cellPointAt`
    // answered null and the gesture has only the block start to offer. The
    // caret still reveals this table, which is the whole point of dispatching
    // anything at all here.
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [null], [], () => BELOW);
    const dom = mount(makeWidget(SRC, 7));
    press(dom, "mousedown", 30, 30); // the root itself: padding, no cell
    press(document.body, "mouseup", 30, 400);
    expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
  });

  it("updateDOM cancels an outside release too (stale-offset guard)", () => {
    // The click seam's counterpart of this row is in cm-table-widget-drag.test.ts.
    // A doc edit landing mid-gesture moves every stamp, so the anchor captured
    // under the old ones must not be paired with a head resolved under the new.
    const dispatched: unknown[] = [];
    const { mount, update } = stubViewWithCaret(
      dispatched,
      [{ text: "alpha", offset: 2 }],
      [],
      () => BELOW
    );
    const first = new TableBlockWidget(parseTable(SRC, 0, SRC.length)!, SRC, 0, 0);
    const dom = mount(first);
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 30, 30);
    update(dom, new TableBlockWidget(parseTable(SRC, 0, SRC.length)!, SRC, 5, 5), first);
    press(document.body, "mouseup", 30, 400);
    // The caret comes from the RE-POINTED block start, not from the anchor.
    expect(dispatched).toEqual([{ selection: { anchor: 5 } }]);
  });

  it("a backwards release above the table snaps an unmappable anchor OUTWARD", () => {
    // Same rule as the across-cells arm of `dragRange`: direction comes from
    // comparing the release position with the cell, and the end that cannot be
    // placed exactly snaps AWAY from the other one, so the range still covers
    // the cell the pointer started in.
    const cell = "a![i](https://x.test/a.png)b";
    const src = `| A |\n| - |\n| ${cell} |`;
    const dispatched: unknown[] = [];
    const { mount } = stubViewWithCaret(dispatched, [{ text: "b", offset: 0 }], [], () => 0);
    const dom = mount(makeWidget(src));
    press(dom.querySelector("td") as HTMLElement, "mousedown", 30, 30);
    press(document.body, "mouseup", 30, 0); // released ABOVE the table
    expect(dispatched).toEqual([
      { selection: { anchor: src.indexOf(cell) + cell.length, head: 0 } },
    ]);
  });

  // The mirror of the row above, and the reason it exists: OUTWARD is a
  // ternary, and until this row only its BACKWARDS arm ever ran. Every other
  // release row scripts a plain-text cell, so `start.offset` is non-null and
  // the `??` short-circuits before the ternary is reached at all. (Measured:
  // collapsing the ternary to `start.offset ?? start.cellTo` left the file
  // green — a "simplify" pass could delete the forward arm and the suite would
  // not notice, after which a forward drag out of an image cell would anchor at
  // the cell END, dropping the very cell the pointer started in.)
  it("a forward release below the table snaps an unmappable anchor OUTWARD", () => {
    const cell = "a![i](https://x.test/a.png)b";
    const src = `| A |\n| - |\n| ${cell} |`;
    const dispatched: unknown[] = [];
    // The junction beside the image is the unmappable boundary, so the anchor
    // has no exact offset and must come from the cell stamps.
    const { mount } = stubViewWithCaret(dispatched, [{ text: "b", offset: 0 }], [], () => BELOW);
    const dom = mount(makeWidget(src));
    press(dom.querySelector("td") as HTMLElement, "mousedown", 30, 30);
    press(document.body, "mouseup", 30, 400); // released BELOW the table
    // Release AFTER the cell → snap away from it, to `data-cell-from`.
    expect(dispatched).toEqual([{ selection: { anchor: src.indexOf(cell), head: BELOW } }]);
  });
});
