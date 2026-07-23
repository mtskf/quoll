import { describe, expect, it } from "vitest";
import { formatDocument } from "../../../src/markdown/format/index.js";
import { structureSignature } from "../../../src/markdown/format/parse-signature.js";

const CORPUS: Record<string, string> = {
  table: "| Name | Age |\n|:--|--:|\n| Alice | 30 |\n| Bob | 5 |\n",
  nestedLists: "1. a\n   1. x\n   1. y\n2. b\n",
  hardBreaks: "line one  \nline two\n\npara two\n",
  fenced: "```ts\nconst x = 1;   \n```\n",
  indentedCode: "para\n\n    code line   \n    more code\n",
  rawHtml: "<table>\n  <tr><td>x</td></tr>\n</table>\n",
  frontmatter: "---\ntitle: T\n---\n\n# H\n\ntext\n",
  widthCrossing: "8. a\n9. b\n9. c\n   1. child\n",
  mixed: "# Doc  \n\n\n\n1. one\n1. two\n\n| a | bb |\n| - | - |\n| 1 | 2 |\n\n```\ncode\n```\n",
};

describe("parse identity (structure preserved, nesting-aware)", () => {
  for (const [name, src] of Object.entries(CORPUS)) {
    it(`${name}: formatted output is structurally equivalent`, () => {
      expect(structureSignature(formatDocument(src))).toBe(structureSignature(src));
    });
  }
});
