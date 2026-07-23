import { describe, expect, it } from "vitest";
import { structureSignature } from "../../../src/markdown/format/parse-signature.js";

describe("structureSignature", () => {
  it("differs when nesting changes (de-nest is visible)", () => {
    const nested = "1. a\n   - x\n"; // BulletList inside ListItem
    const flat = "1. a\n- x\n"; // sibling lists
    expect(structureSignature(nested)).not.toBe(structureSignature(flat));
  });
  it("is stable across whitespace-only reformatting (table padding)", () => {
    expect(structureSignature("| a | b |\n| - | - |\n| 1 | 2 |\n")).toBe(
      structureSignature("| a | b |\n| --- | --- |\n| 1   | 2   |\n")
    );
  });
});
