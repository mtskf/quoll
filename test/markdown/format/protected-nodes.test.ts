import { describe, expect, it } from "vitest";
import { formatDocument } from "../../../src/markdown/format/index.js";

// Byte-preservation pins for each protected block node. Each source packs trailing
// whitespace INSIDE the block, so if its node name were dropped from PROTECTED_NODES
// the trailing-trim pass would rewrite the bytes and the test would go RED.
describe("formatDocument — protected node byte-preservation", () => {
  it("preserves trailing whitespace inside indented code (CodeBlock)", () => {
    const src = "para\n\n    code line   \n    more code   \n";
    expect(formatDocument(src)).toBe(src);
  });
  it("preserves trailing whitespace inside an HTML comment (CommentBlock)", () => {
    const src = "<!--\n  keep   \n-->\n";
    expect(formatDocument(src)).toBe(src);
  });
  it("preserves trailing whitespace inside a processing instruction (ProcessingInstructionBlock)", () => {
    const src = "<?x\n  y   \n?>\n";
    expect(formatDocument(src)).toBe(src);
  });
});
