// @vitest-environment happy-dom
// The collapsed-caret dispatch path and its trust boundary: a cell stamp read
// back off the DOM is untrusted input, so every malformed or hostile value must
// fall back to the block start rather than install a broken selection. Range
// selection is cm-table-widget-drag.test.ts. Fixtures: helpers/widget-fixtures.ts.
import { EditorState } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

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
  // `console.error` is the only observable difference. The anchor VALUE
  // cannot distinguish them here (nor in any other fixture across these
  // widget suites that clicks right after toDOM): both trace back to the same
  // `docFrom`
  // constructor argument, so deleting `blockStart.set(root, this.docFrom)`
  // in `toDOM` leaves every such anchor assertion green. (The updateDOM
  // re-stamp fixture in cm-table-widget-update.test.ts stays green for an
  // unrelated reason: its OWN
  // `blockStart.set` write re-fills the entry with the new docFrom.)
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
});
