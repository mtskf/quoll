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
    // stripped-delimiter clause reds NOTHING in this file — every other row that flips one
    // of them also flips a second fact, so the surviving clauses cover for the missing one
    // (measured, 2026-09-05). Each row below flips EXACTLY ONE fact:
    ["head|", "head\\|", true], //                  hasPipe ONLY (raw/stripped false both
    //                                             sides, cell count 1 -> 1)
    ["  |--x|---|", "  |---|---|", true], //       STRIPPED delimiter ONLY (leading
    //                                             whitespace + `|` keeps RAW false on both
    //                                             sides, cell count 2 -> 2)
    ["| a | b |", "| a \\| b |", true], //         cell count 2 -> 1 (hasPipe stays TRUE here:
    //                                             the outer pipes are unescaped — do NOT use
    //                                             this row to check the hasPipe clause)
    ["|--x|---|", "|---|---|", true], //           delimiter-ness completes
    ["|---|---|", "|--x|---|", true], //           delimiter-ness breaks
    [" :---|", " |:---|", true], //                RAW delimiter-ness only (Fable ex. 1)
    ["  :-|", "  |:-|", true], //                  RAW delimiter-ness only (Fable ex. 2)
    ["| a | b |", "| a b |", true], //             cell count drops
    ["| a | b |", "| a | b | c |", true], //       cell count rises
    ["a | b", "  | b", true], //                   leading cell empties (count 2 -> 1)
    // --- must NOT fire: the hot path this narrowing exists to recover ---
    ["| alpha | beta |", "| alphaX | beta |", false],
    ["| a | b |", "| a | bb |", false],
    ["| c | d |", "| cX | d |", false],
    ["|---|---|", "|----|---|", false], //         same delimiter shape, same cell count
    ["|---|---|", "|:--|---|", false], //          alignment only (table is re-walked in-span)
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
