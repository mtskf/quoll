import { describe, expect, it } from "vitest";
import { formatDocument, formatDocumentEdits } from "../../../src/markdown/format/index.js";

const CORPUS = [
  "| a | bbbb |\n| - | - |\n| 1 | 2 |\n",
  "1. a\n1. b\n1. c\n",
  "9. a\n9. b\n",
  "text  \nwith hard break\n\n\n\nand blanks\n",
  "```\ncode  spaced   \n```\n",
  "---\ntitle: x\n---\n\n1. a\n   1. x\n   1. y\n2. b\n",
  "<div>\n  raw   \n</div>\n",
  "no trailing newline",
];

describe("formatDocument idempotence", () => {
  for (const [i, doc] of CORPUS.entries()) {
    it(`corpus[${i}] second run is a no-op`, () => {
      const once = formatDocument(doc);
      expect(formatDocument(once)).toBe(once);
      expect(formatDocumentEdits(once)).toEqual([]);
    });
  }
});
