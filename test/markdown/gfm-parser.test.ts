import { describe, expect, it } from "vitest";
import { gfmParser } from "../../src/markdown/gfm-parser.js";

describe("gfmParser", () => {
  it("parses a GFM table (GFM extension is configured)", () => {
    const tree = gfmParser.parse("| a | b |\n| - | - |\n| 1 | 2 |\n");
    let sawTable = false;
    tree.iterate({
      enter: (n) => {
        if (n.name === "Table") {
          sawTable = true;
        }
      },
    });
    expect(sawTable).toBe(true);
  });

  it("emits a HardBreak node for a two-space line break", () => {
    const tree = gfmParser.parse("a  \nb\n");
    let sawHardBreak = false;
    tree.iterate({
      enter: (n) => {
        if (n.name === "HardBreak") {
          sawHardBreak = true;
        }
      },
    });
    expect(sawHardBreak).toBe(true);
  });
});
