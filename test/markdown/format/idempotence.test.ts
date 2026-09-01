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
  "* a\n* b\n",
  "+ a\n\n# h\n\n* b\n",
  "* a\n+ b\n",
  "* a\n  + x\n  - y\n",
  "> * a\n> - b\n",
  "> * a\n> * b\n",
  "* --\n",
  "* good\n\n# separator\n\n* a\n* --\n",
  "+ + +\n",
  "* x\n* y\n\n# s\n\n+ + +\n",
  "* a\n* --\n* b\n",
  "* [ ] a\n* [x] b\n",
  "* -\n",
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
