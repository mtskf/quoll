// Real-browser gate for the DESIGN PREMISE behind table-cell drag selection
// (C6b) — the half table-drag-selection.browser.test.ts's gesture contracts
// depend on but cannot show.
//
// cell-point.ts exists because a drag over the table widget CANNOT be recovered
// from `window.getSelection()` at mouseup: the widget's DOM is a
// `contenteditable=false` island inside CodeMirror's editable content, and a
// selection made inside it is one CodeMirror cannot map to a document position,
// so `DOMObserver.flush()` concludes the view is out of sync and re-imposes a
// collapsed DOM selection of its own. Hence the widget maps pointer COORDINATES
// itself.
//
// ⚠️ What this suite pins is the DESTRUCTION, not the destination: after an
// observer pass the widget-internal DOM range is GONE, which is the whole of
// what the design needs. Where CodeMirror then parks the caret is incidental
// (this run measures the table block start; the manual Chromium session in
// LEARNING.md 2026-08-12 saw document position 0 under different conditions),
// and pinning it would make a harmless upstream change go red for nothing.
//
// Unreachable in happy-dom: no layout engine, so there is no real selection to
// destroy and no observer pass worth running.
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { settled } from "./helpers/frames.js";
import {
  cellByText,
  DELTA,
  dragPointer,
  firstText,
  flushObserver,
  GAMMA,
  mount,
  pointAtChar,
  unmount,
} from "./helpers/table-drag-harness.js";

let view: EditorView | undefined;
afterEach(() => {
  unmount(view);
  view = undefined;
});

describe("table widget selection — CodeMirror's DOMObserver", () => {
  it("destroys a widget-internal DOM range, so the widget can never read one back", async () => {
    // The exact situation a native drag leaves behind mid-gesture: a real DOM
    // range spanning two cells of the widget, and nothing dispatched. One
    // observer pass later the range is gone — which is precisely why
    // cell-point.ts maps coordinates instead of reading the selection.
    view = mount();
    await settled();
    view.focus();
    const from = cellByText(view, "gamma");
    const to = cellByText(view, "delta");
    window.getSelection()?.setBaseAndExtent(firstText(from), 1, firstText(to), 3);
    expect(window.getSelection()?.isCollapsed, "a real DOM range exists first").toBe(false);

    flushObserver(view);
    await settled();

    expect(
      window.getSelection()?.isCollapsed ?? true,
      "the widget-internal DOM range did not survive the observer pass"
    ).toBe(true);
    expect(
      view.state.selection.main.empty,
      "and the state selection it installed instead is collapsed"
    ).toBe(true);
  });

  it("owns the DOM selection after a completed drag: it matches the dispatched range", async () => {
    // The mirror image of the test above, and the reason the gesture suite's
    // ranges are stable. Once the widget dispatches, the reveal replaces the
    // widget with real editable text, and CodeMirror's own post-dispatch
    // `docView.updateSelection()` writes a DOM selection that AGREES with
    // `state.selection` — so there is no unmappable range left for any later
    // observer pass to destroy. Asserting the DOM text (not just "the state
    // range is still there") is what keeps this a real check: it can only pass
    // while CM is genuinely painting the dispatched range on screen.
    view = mount();
    await settled();
    const from = cellByText(view, "gamma");
    const to = cellByText(view, "delta");
    await dragPointer(from, pointAtChar(from, 1), to, pointAtChar(to, 3));
    await settled();

    const sel = view.state.selection.main;
    expect(sel.anchor).toBe(GAMMA + 1);
    expect(sel.head).toBe(DELTA + 3);

    const dom = window.getSelection();
    expect(dom?.isCollapsed, "CM paints the dispatched range").toBe(false);
    expect(dom?.toString(), "and the painted text IS the dispatched slice").toBe(
      view.state.sliceDoc(sel.from, sel.to)
    );

    flushObserver(view);
    await settled();
    expect(view.state.selection.main.anchor, "an observer pass now changes nothing").toBe(
      sel.anchor
    );
    expect(view.state.selection.main.head).toBe(sel.head);
  });
});
