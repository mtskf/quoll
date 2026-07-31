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
  bulletStandalone: "* a\n* b\n* c\n",
  bulletPlus: "+ a\n+ b\n",
  bulletAdjacentDiff: "* a\n+ b\n",
  bulletBlankSepDiff: "* a\n\n- b\n",
  bulletNested: "* a\n  + x\n  - y\n* b\n",
  bulletSepByHeading: "* a\n\n# h\n\n+ b\n",
  bulletMixedWithOrdered: "1. a\n2. b\n\n* x\n* y\n",
  bulletBlockquoteAdjacent: "> * a\n> - b\n",
  bulletBlockquoteStandalone: "> * a\n> * b\n",
  bulletBlockquoteSepByPara: "> * a\n>\n> text\n>\n> - b\n",
  bulletThreeMarkerRun: "* a\n+ b\n- c\n",
  bulletThematicBreakItem: "* --\n",
  bulletThematicBreakInList: "* a\n* --\n",
  bulletThematicBreakPlus: "+ - -\n",
  bulletCollisionAmongSafe: "* good\n\n# separator\n\n* a\n* --\n",
  bulletDeepBlockquote: "> > * a\n> > - b\n",
};

describe("parse identity (structure preserved, nesting-aware)", () => {
  for (const [name, src] of Object.entries(CORPUS)) {
    it(`${name}: formatted output is structurally equivalent`, () => {
      expect(structureSignature(formatDocument(src))).toBe(structureSignature(src));
    });
  }
});
