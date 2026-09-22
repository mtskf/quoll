// @vitest-environment happy-dom
// The collapsed-caret dispatch path and its trust boundary: a cell stamp read
// back off the DOM is untrusted input, so every malformed or hostile value must
// fall back to the block start rather than install a broken selection. Range
// selection is cm-table-widget-drag.test.ts. Fixtures: helpers/widget-fixtures.ts.
import { EditorState } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { asAbsoluteOffset } from "../../../src/webview/cm/table/cell-point.js";
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
    const dom = makeWidget(SRC, 7).toDOM(stubView(dispatched));
    document.body.appendChild(dom);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    td.setAttribute("data-cell-from", raw);
    press(td, "click", 10, 10);
    // The block start, NOT `Number(raw)` — reveal-on-caret is line-level, so
    // this still reveals the table; only intra-table precision is lost.
    expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
  });

  // The ROOT position, unlike the cell stamps, is NOT an input from the DOM.
  // `data-doc-from` is still written (DOM inspection, plus the re-stamp
  // assertions in cm-table-widget-update.test.ts), but the block-start fallback
  // reads the module-private WeakMap, so a value written onto the element
  // cannot steer the dispatch.
  //
  // "999" alone kills both reverts — it dispatches 999 (≠ 7, this fixture's
  // expected anchor) whether read BARE (`Number(root.dataset.docFrom)`) or
  // via the pre-refactor GATED read (`stampedOffset(root, "data-doc-from")
  // ?? this.docFrom`), since "999" also passes the gate's `/^\d+$/`. "abc"
  // is redundant against the gated read — it fails the gate and falls
  // through to `this.docFrom`, leaving that revert green — but earns its
  // place against the bare read: it dispatches `NaN`, silently accepted by
  // `checkSelection` (rejects only `range.to > doc.length`), breaking the
  // selection silently. (Each revert applied; red rows observed.)
  it.each([
    ["malformed", "abc"],
    ["well-formed but wrong", "999"],
  ])("ignores a %s data-doc-from written onto the widget root", (_label, raw) => {
    const dispatched: unknown[] = [];
    const dom = makeWidget(SRC, 7).toDOM(stubView(dispatched));
    document.body.appendChild(dom);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    td.setAttribute("data-cell-from", "abc"); // force the block-start fallback
    dom.setAttribute("data-doc-from", raw);
    press(td, "click", 10, 10);
    // 7 is the constructor argument, carried in the WeakMap — it never
    // travelled through the DOM.
    expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
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
      dispatch: () => {
        throw new Error("dispatch boom");
      },
    } as unknown as EditorViewType;
    const dom = makeWidget(SRC, 7).toDOM(view);
    document.body.appendChild(dom);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const td = dom.querySelectorAll("td")[0] as HTMLElement;
      expect(() => press(td, "click", 10, 10)).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith("[quoll] table widget selection dispatch failed", {
        selection: { anchor: SRC.indexOf("alpha") },
        err: expect.any(Error),
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  // A fresh toDOM'd widget's margin click must hit the `blockStart` entry
  // written in toDOM, not `blockStartCaret`'s miss fallback — the absent
  // `console.error` is the only observable difference. The anchor VALUE cannot
  // distinguish them here (nor in any other fixture across these widget suites
  // that clicks right after toDOM): both trace back to the same `docFrom`
  // constructor argument, so deleting `blockStart.set(root, this.docFrom)` in
  // `toDOM` leaves every such anchor assertion green. (The one MARGIN click
  // that lands after updateDOM — "re-stamps offsets on updateDOM so a click
  // after a shift uses the new base", in cm-table-widget-render.test.ts —
  // stays green for an unrelated reason: updateDOM's OWN `blockStart.set`
  // write re-fills the entry with the new docFrom. The drag suite's two
  // post-updateDOM rows click a CELL, so they never reach `blockStart` at
  // all.)
  it("does not log a blockStart miss when a fresh toDOM'd widget's margin is clicked", () => {
    const dispatched: unknown[] = [];
    const dom = makeWidget(SRC, 7).toDOM(stubView(dispatched));
    document.body.appendChild(dom);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      dom.click(); // the root div, not a cell
      expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  // `blockStartOf` reads `widget.docFrom` — never `widget.nodeFrom`, a
  // same-typed adjacent field nothing at the type level rules out (see its
  // docblock). Pin the margin-click dispatch against a fixture where the two
  // differ, so a future edit that swaps the field compiles clean and goes red
  // here instead of shipping a margin click that lands inside the table.
  // Assert the precondition on the widget itself (not just on a comment
  // about `makeWidget`'s current default): if a later change to the helper
  // stops distinguishing the two fields, this fails loudly here rather than
  // silently pinning nothing. (The docFrom/nodeFrom mix-up is ALSO caught
  // incidentally by ~11 other tests across this suite and
  // cm-table-widget-render.test.ts / cm-table-widget-release.test.ts, since
  // most fixtures already pass a non-zero docFrom with nodeFrom defaulted to
  // 0 — this test exists to NAME the invariant at `blockStartOf` so that
  // coverage isn't merely incidental and survives a fixture rewrite.)
  it("blockStartOf's margin-click anchor tracks docFrom, not nodeFrom", () => {
    const widget = makeWidget(SRC, 11); // docFrom 11, nodeFrom 0 (widget-fixtures.ts)
    expect(widget.docFrom).not.toBe(widget.nodeFrom);
    const dispatched: unknown[] = [];
    const dom = widget.toDOM(stubView(dispatched));
    document.body.appendChild(dom);
    dom.click(); // the root div, not a cell
    expect(dispatched).toEqual([{ selection: { anchor: widget.docFrom } }]);
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
