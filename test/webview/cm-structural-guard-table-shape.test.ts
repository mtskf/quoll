// @vitest-environment happy-dom
//
// Unit pins for the narrowed TABLE-DELIM arm. EVERY case carries an EXPLICIT expected
// verdict — an implication-only assertion (`ranges differ ⇒ predicate true`) silently
// verifies nothing on the cases where the ranges happen not to differ, so a typo or an
// upstream change would leave it green (Fable finding 4).
import { describe, expect, it } from "vitest";
import { tableRowShapeChanged } from "../../src/webview/cm/structural-guard.js";

describe("tableRowShapeChanged", () => {
  it.each([
    // [old line, new line, expected]
    // --- must FIRE: the four facts, one per row ---
    ["a b", "a | b", true], //                     hasPipe appears (and cell count 1 -> 2)
    ["a\\|b", "a|b", true], //                     hasPipe appears from behind an escape
    // ⚠️ CLAUSE-ISOLATING rows. Without these two, deleting the hasPipe clause or the
    // STRIPPED read inside `isTableDelimiterShaped` reds NOTHING in this file — every other
    // row that flips one of them also flips a second fact, so the surviving clauses cover
    // for the missing one (measured, 2026-09-05). Each row below reaches EXACTLY ONE clause:
    ["head|", "head\\|", true], //                  hasPipe ONLY (delimiter-shaped false on
    //                                             both sides raw AND stripped, so the
    //                                             presence retreat never fires; count 1 -> 1)
    ["  |--x|---|", "  |---|---|", true], //       the STRIPPED read ONLY (leading whitespace
    //                                             + `|` keeps the RAW read false on both
    //                                             sides; `  |--x|---|` is not
    //                                             delimiter-shaped either way, and the cell
    //                                             count is 2 -> 2, so only the new side's
    //                                             stripped read can fire)
    ["| a | b |", "| a \\| b |", true], //         cell count 2 -> 1 (hasPipe stays TRUE here:
    //                                             the outer pipes are unescaped — do NOT use
    //                                             this row to check the hasPipe clause)
    ["|--x|---|", "|---|---|", true], //           delimiter-ness completes
    ["|---|---|", "|--x|---|", true], //           delimiter-ness breaks
    // A delimiter-shaped line on EITHER side is a PRESENCE retreat, so an edit that keeps
    // the shape (and the cell count) fires too. That is the accepted cost of the two parser
    // facts a per-line mirror cannot carry — `nextLine`'s `line.next ∈ {-,:,|}` gate, which
    // lezer decides with a `skipSpace` that stops at NBSP / U+3000 / `\f` / `\v` where
    // `delimiterLine`'s `\s` does not, and `endLeaf`'s `parseRow(cx, next, line.basePos)`
    // measuring the delimiter line from the PRECEDING line's offset. Both were reproduced
    // against the real parser destroying a whole `Table` with all four old facts constant
    // (2026-09-06). ⚠️ These two rows were `false` before that repair: if either goes back
    // to `false`, the retreat has been undone and both holes are open again.
    ["|---|---|", "|----|---|", true], //          same delimiter shape, same cell count
    ["|---|---|", "|:--|---|", true], //           alignment only
    [" :---|", " |:---|", true], //                RAW delimiter-ness only (Fable ex. 1)
    ["  :-|", "  |:-|", true], //                  RAW delimiter-ness only (Fable ex. 2)
    ["| a | b |", "| a b |", true], //             cell count drops
    ["| a | b |", "| a | b | c |", true], //       cell count rises
    ["a | b", "  | b", true], //                   leading cell empties (count 2 -> 1)
    // --- must NOT fire: the hot path this narrowing exists to recover ---
    ["| alpha | beta |", "| alphaX | beta |", false],
    ["| a | b |", "| a | bb |", false],
    ["| c | d |", "| cX | d |", false],
    ["plain prose", "plain prosex", false],
  ])("%s -> %s === %s", (oldLine, newLine, expected) => {
    expect(tableRowShapeChanged(oldLine, newLine)).toBe(expected);
  });

  it("is symmetric — undoing an edit agrees with making it", () => {
    for (const [a, b] of [
      [" :---|", " |:---|"],
      ["|--x|---|", "|---|---|"],
      ["| alpha | beta |", "| alphaX | beta |"],
    ] as const) {
      expect(tableRowShapeChanged(b, a)).toBe(tableRowShapeChanged(a, b));
    }
  });
});
