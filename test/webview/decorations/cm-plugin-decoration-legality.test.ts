// @vitest-environment happy-dom
import { type Range, Text } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { findPluginIllegalDecoration } from "../../../src/webview/cm/decorations/plugin-decoration-legality.js";

class Stub extends WidgetType {
  toDOM(): HTMLElement {
    return document.createElement("span");
  }
  eq(): boolean {
    return true;
  }
}

/** A block widget at `pos` — the zero-length shape a ViewPlugin may never
 *  emit. `block: true` is the load-bearing bit, so it is spelled once. */
function blockWidget(pos: number): Range<Decoration> {
  return Decoration.widget({ widget: new Stub(), block: true }).range(pos);
}

// Lines: 0..5, 6..11, 12..17. Length 17.
const doc = Text.of(["hello", "world", "again"]);

describe("findPluginIllegalDecoration — legal sets", () => {
  it("passes an empty set", () => {
    expect(findPluginIllegalDecoration(Decoration.none, doc)).toBeNull();
  });

  it("passes a mark-only set", () => {
    const set = Decoration.set([Decoration.mark({ class: "a" }).range(0, 3)]);
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });

  it("passes line decorations (points, but never PointDecoration)", () => {
    const set = Decoration.set([Decoration.line({ class: "l" }).range(6)]);
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });

  it("passes an inline widget and a within-line replace", () => {
    const set = Decoration.set(
      [Decoration.widget({ widget: new Stub() }).range(2), Decoration.replace({}).range(6, 11)],
      true
    );
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });

  it("does NOT reject a stray `block` property in a MARK spec", () => {
    // Decoration specs allow arbitrary extra properties, and spec.block is read
    // only at construction. Keying off spec.block instead of PointDecoration's
    // own field would drop this legal provider.
    const set = Decoration.set([Decoration.mark({ class: "a", block: true }).range(0, 3)]);
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });

  it("does NOT reject a range that lies wholly past the end of the doc", () => {
    // Judged on its extent clipped at doc.length — see the `docEnd` comment in
    // plugin-decoration-legality.ts for why that clip is the safe direction.
    // Probed: CM does not throw for this. Over-rejecting here would drop a
    // provider CodeMirror was happy with.
    const set = Decoration.set([Decoration.replace({}).range(17, 25)]);
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });

  it("does NOT reject a BLOCK decoration positioned wholly past the end of the doc", () => {
    // RangeSet.spans never visits it, so CodeMirror never judges it — probed.
    // This is the ONLY test that holds `cursor.from <= docEnd` in place: without
    // that clause the walk returns "a block decoration at 25..25" and drops a
    // provider CodeMirror accepted.
    const set = Decoration.set([blockWidget(25)]);
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });

  it("does NOT reject a range that starts in the last line and runs past the end", () => {
    // The partial-overlap-at-EOF shape: spans clips `to` to doc.length (17),
    // which equals the last line's end, so the line-break rule must not fire.
    // Pinned separately from the wholly-out-of-bounds case because it is the
    // one where the clip lands exactly ON the boundary the rule compares to.
    const set = Decoration.set([Decoration.replace({}).range(14, 25)]);
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });
});

describe("findPluginIllegalDecoration — illegal sets", () => {
  it("rejects a BLOCK widget (a ZERO-LENGTH point)", () => {
    const set = Decoration.set([blockWidget(6)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe("a block decoration at 6..6");
  });

  it("rejects a BLOCK replace", () => {
    const set = Decoration.set([Decoration.replace({ block: true }).range(6, 11)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe("a block decoration at 6..11");
  });

  it("rejects a replace that spans a line break", () => {
    const set = Decoration.set([Decoration.replace({}).range(2, 8)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe(
      "a decoration replacing a line break at 2..8"
    );
  });

  it("rejects a replace of the line break ITSELF", () => {
    // `from` sits exactly at a line end, so doc.lineAt(from).to === from and the
    // replace covers only the newline. CodeMirror throws here too.
    const set = Decoration.set([Decoration.replace({}).range(5, 6)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe(
      "a decoration replacing a line break at 5..6"
    );
  });

  it("rejects a block widget at the very end of the document", () => {
    const set = Decoration.set([blockWidget(17)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe("a block decoration at 17..17");
  });

  // Every negative-start shape is reported, and each fixture below forbids a
  // DIFFERENT tempting "simplification" of that rule. Skipping them
  // (`cursor.from >= 0`) leaks the first two to CodeMirror, which throws;
  // clamping `from` to 0 to mirror RangeSet.spans makes the third look legal,
  // and CodeMirror then crashes on it in TileBuilder.continueWidget. All three
  // escape view.dispatch(), which is the whole point of this module.

  it("rejects a negative-start replace that crosses a line break once clamped", () => {
    // spans visits this as 0..8, crossing the newline at 5 — CM throws.
    const set = Decoration.set([Decoration.replace({}).range(-1, 8)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe("a decoration at a negative position -1..8");
  });

  it("rejects a negative-start BLOCK replace", () => {
    // Visited as 0..3, and block is forbidden outright wherever it lands.
    const set = Decoration.set([Decoration.replace({ block: true }).range(-1, 3)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe("a decoration at a negative position -1..3");
  });

  it("rejects a negative-start replace CodeMirror crashes on rather than rejects", () => {
    // The one that forbids clamping: spans visits it as 0..3, which breaks
    // neither documented rule, so a clamping detector calls it legal — and CM
    // then dies in TileBuilder.continueWidget ("Cannot read properties of
    // null"), raised from the same emit() walk and escaping dispatch.
    const set = Decoration.set([Decoration.replace({}).range(-1, 3)]);
    expect(findPluginIllegalDecoration(set, doc)).toBe("a decoration at a negative position -1..3");
  });
});

describe("findPluginIllegalDecoration — ranges the cursor never yields", () => {
  it("passes a range lying wholly before the document", () => {
    // Not an exception to the negative-position rule — the walk never sees it.
    // `built.iter()` defaults to `from = 0`, so a range ending before 0 is
    // skipped by the initial goto, which is exactly what RangeSet.spans visits
    // over the same window. CM tolerates it too (probed: no throw), so passing
    // it is the EXACT answer here rather than a deliberate leniency.
    const set = Decoration.set([Decoration.replace({}).range(-5, -3)]);
    expect(findPluginIllegalDecoration(set, doc)).toBeNull();
  });
});

describe("findPluginIllegalDecoration — LAYERED sets (the regression that matters)", () => {
  // RangeSetBuilder.add spills any range OVERLAPPING the previous one into a
  // nextLayer builder, and finishInner only carries the top layer's setMaxPoint.
  // So `Decoration.set([...]).maxPoint` is -1 for both sets below even though
  // they carry a point — any detector gated on a top-level maxPoint reports them
  // legal while CodeMirror still throws. An illegal decoration overlapping an
  // existing mark is the REALISTIC provider-bug shape, so these two cases are
  // the ones the guard exists for.

  it("rejects a block widget that spilled into a second layer", () => {
    const set = Decoration.set(
      [Decoration.mark({ class: "m" }).range(0, 10), blockWidget(5)],
      true
    );
    expect(findPluginIllegalDecoration(set, doc)).toBe("a block decoration at 5..5");
  });

  it("rejects a cross-line replace that spilled into a second layer", () => {
    const set = Decoration.set(
      [Decoration.mark({ class: "m" }).range(0, 10), Decoration.replace({}).range(2, 8)],
      true
    );
    expect(findPluginIllegalDecoration(set, doc)).toBe(
      "a decoration replacing a line break at 2..8"
    );
  });
});

describe("findPluginIllegalDecoration — ordering", () => {
  it("reports the FIRST offender when legal points precede it", () => {
    // Pins the ordered walk across three lines: three legal within-line replaces
    // must not be mistaken for the offender, and must not confuse doc.lineAt.
    const set = Decoration.set(
      [
        Decoration.replace({}).range(0, 2),
        Decoration.replace({}).range(6, 8),
        Decoration.replace({}).range(12, 14),
        blockWidget(15),
      ],
      true
    );
    expect(findPluginIllegalDecoration(set, doc)).toBe("a block decoration at 15..15");
  });
});
