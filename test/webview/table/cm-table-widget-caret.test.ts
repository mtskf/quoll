// @vitest-environment happy-dom
// The collapsed-caret dispatch path and its trust boundary: a cell stamp read
// back off the DOM is untrusted input, so every malformed or hostile value must
// fall back to the block start rather than install a broken selection. Range
// selection is cm-table-widget-drag.test.ts. Fixtures: helpers/widget-fixtures.ts.
import { EditorState } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { asAbsoluteOffset, stampedOffset } from "../../../src/webview/cm/table/cell-point.js";
import {
  asCellSourceOffset,
  asRenderedOffset,
} from "../../../src/webview/cm/table/cell-source-map.js";
import type { TableSelection } from "../../../src/webview/cm/table/table-widget.js";

import { makeWidget, press, SRC, stubView } from "./helpers/widget-fixtures.js";

describe("TableBlockWidget caret dispatch hardening", () => {
  // The caret path reads `data-cell-from` off the DOM — the per-cell offset has
  // to live there, since `cellPointAt` resolves whatever descendant is under the
  // pointer — so it sits on the same trust boundary as the drag path and must
  // use the same gate. A bare `Number(...)` here would not merely be untidy:
  // CodeMirror's `checkSelection` tests `range.to > doc.length` and nothing
  // else, so a `NaN` anchor is ACCEPTED and installs a range whose `from` is
  // `NaN` — a silently broken selection, with no throw for
  // `dispatchSelection`'s catch to see.
  // Hence the assertions below are on the exact dispatched value, not on
  // "something was dispatched".
  it.each([
    ["empty", ""],
    ["negative", "-5"],
    ["fractional", "78.5"],
    ["non-numeric", "abc"],
    ["precision-losing", "9007199254740993"],
  ])("falls back to the block start for a %s cell stamp", (_label, raw) => {
    const dispatched: unknown[] = [];
    const view = stubView(dispatched, undefined, undefined, 7);
    const dom = makeWidget(SRC).toDOM(view);
    view.contentDOM.appendChild(dom);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    td.setAttribute("data-cell-from", raw);
    press(td, "click", 10, 10);
    // The block start, NOT `Number(raw)` — reveal-on-caret is line-level, so
    // this still reveals the table; only intra-table precision is lost.
    expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
  });

  // The two null arms of the block-start lookup drop the gesture, so the log is
  // the only trace a dead click leaves — pinned so neither arm goes silent.
  it("a foreign table root dispatches nothing and logs why", () => {
    const dispatched: unknown[] = [];
    const view = stubView(dispatched, undefined, undefined, 7);
    const dom = makeWidget(SRC).toDOM(view);
    document.body.appendChild(dom);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      press(dom.querySelector("td")!, "click", 10, 10);
      expect(dispatched).toEqual([]);
      // Exact arguments: the log names the failure and carries no document text.
      expect(consoleError).toHaveBeenCalledWith("[quoll] table widget root not in contentDOM");
    } finally {
      consoleError.mockRestore();
      dom.remove();
    }
  });

  it("a throwing block-position lookup dispatches nothing and logs the error", () => {
    const dispatched: unknown[] = [];
    const boom = new Error("posAtDOM boom");
    const view = stubView(dispatched);
    (view as unknown as { posAtDOM: () => number }).posAtDOM = () => {
      throw boom;
    };
    const dom = makeWidget(SRC).toDOM(view);
    view.contentDOM.appendChild(dom);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      press(dom.querySelector("td")!, "click", 10, 10);
      expect(dispatched).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        "[quoll] table widget block position lookup failed",
        { err: boom }
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  // `dispatchSelection` is the single window through which every dispatch in
  // this widget passes, and its catch is unreachable from any fixture the suite
  // can build: with the stamps validated, the throws that remain are a stale
  // out-of-range offset, CodeMirror's re-entrancy error, and a throwing
  // transaction filter — none of which a display-only widget test can stage.
  // Without this pin the whole try/catch could be replaced by a bare
  // `view.dispatch(...)` with the suite still green.
  it("logs and swallows a throwing dispatch instead of letting it escape the DOM listener", () => {
    const view = {
      state: EditorState.create({}),
      contentDOM: document.createElement("div"),
      posAtDOM: () => 7,
      dispatch: () => {
        throw new Error("dispatch boom");
      },
    } as unknown as EditorViewType;
    const dom = makeWidget(SRC).toDOM(view);
    view.contentDOM.appendChild(dom);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const td = dom.querySelectorAll("td")[0] as HTMLElement;
      expect(() => press(td, "click", 10, 10)).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith("[quoll] table widget selection dispatch failed", {
        selection: { anchor: 7 + SRC.indexOf("alpha") },
        err: expect.any(Error),
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});

// The offset-space brand at the sink. `dispatchSelection` is module-private, so
// the pin targets `TableSelection` — which is DERIVED from that function
// (`Parameters<typeof dispatchSelection>[1]`), not declared beside it. That
// derivation is the whole point: a free-standing interface would stay green if
// someone loosened the function's own parameter back to `number`, which is the
// exact regression these rows exist to catch. Each row is its own statement
// because `@ts-expect-error` suppresses only the statement that follows it, and
// each local is CONSUMED — `noUnusedLocals` is unset and Biome's
// `noUnusedVariables` is a warning, so an unused pin would rot silently.
// Same idiom as the `absolute offset brand` block in cm-table-cell-point.test.ts.
describe("dispatchSelection offset-space brand", () => {
  const abs = asAbsoluteOffset(12);

  it("refuses a plain number as either end", () => {
    // @ts-expect-error — a plain `number` is not an AbsoluteOffset.
    const anchorRaw: TableSelection = { anchor: 12 };
    // @ts-expect-error — a plain `number` is not an AbsoluteOffset.
    const headRaw: TableSelection = { anchor: abs, head: 12 };
    expect([anchorRaw.anchor, headRaw.head]).toEqual([12, 12]);
  });

  it("refuses a cell-relative source offset as either end", () => {
    // @ts-expect-error — a CellSourceOffset is not an AbsoluteOffset.
    const anchorCell: TableSelection = { anchor: asCellSourceOffset(3) };
    // @ts-expect-error — a CellSourceOffset is not an AbsoluteOffset.
    const headCell: TableSelection = { anchor: abs, head: asCellSourceOffset(3) };
    expect([anchorCell.anchor, headCell.head]).toEqual([3, 3]);
  });

  it("refuses a block-relative stamp as either end", () => {
    const cell = document.createElement("td");
    cell.dataset.cellFrom = "4";
    const stamp = stampedOffset(cell, "data-cell-from")!;
    // @ts-expect-error — a BlockOffset is not an AbsoluteOffset.
    const anchorBlock: TableSelection = { anchor: stamp };
    // @ts-expect-error — a BlockOffset is not an AbsoluteOffset.
    const headBlock: TableSelection = { anchor: abs, head: stamp };
    expect([anchorBlock.anchor, headBlock.head]).toEqual([4, 4]);
  });

  it("refuses a rendered-text offset as either end", () => {
    // @ts-expect-error — a RenderedOffset is not an AbsoluteOffset.
    const anchorRendered: TableSelection = { anchor: asRenderedOffset(4) };
    // @ts-expect-error — a RenderedOffset is not an AbsoluteOffset.
    const headRendered: TableSelection = { anchor: abs, head: asRenderedOffset(4) };
    expect([anchorRendered.anchor, headRendered.head]).toEqual([4, 4]);
  });

  // The positive half. Without it the rows above would still pass if the shape
  // became uninhabitable (say `anchor: never`), and the second row pins that
  // `head` is genuinely OPTIONAL rather than merely branded.
  it("accepts an absolute offset, with and without a head", () => {
    const caret: TableSelection = { anchor: abs };
    const range: TableSelection = { anchor: abs, head: asAbsoluteOffset(20) };
    expect([caret.head, range.head]).toEqual([undefined, 20]);
  });
});
