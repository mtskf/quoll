// Corpus + edit enumerator shared by the structural-guard proofs.
//
// The enumeration is BOUNDED-EXHAUSTIVE, not random: every single-character insert,
// delete and replace at every offset of every document. That is the only shape of
// evidence that reaches this bug class — the counterexample that broke rev. 1 of the
// plan needs a specific document geometry AND one specific offset, which a uniform
// random fuzz finds with probability ≈ 0 (Fable review, 2026-09-05). It is also cheap:
// ~44k edits parse in well under a second.
export const SHAPE_CORPUS: readonly string[] = [
  // plain tables, trailing-paragraph overshoot, adjacent tables
  "| a | b |\n|---|---|\n| c | d |\ntrailing prose\n\nafter\n",
  "| a | b |\n|---|---|\n\n| x | y |\n|---|---|\n",
  "|a|b|\n|-|-|\n|c|d|\n|e|f|\n|g|h|\n",
  "| a |\n|---|\n| b |\n| c |\n| d |\n",
  "| a | b | c |\n|---|---|\n| d | e |\n",
  "|a\\|b|c|\n|---|---|\n",
  "| a\\|b | c |\n|---|---|\n| d | e |\n",
  "head | only\n---|---\n",
  "a | b\n:--- | ---:\nc | d\n",
  "text\n| a | b |\n|--- |--- |\nrow\n",
  "para one\n| a | b |\n|--x|---|\nmore\n\ntail\n",
  "term | def\n---- | ----\nrow  | val\nlazy continuation\nstill lazy\n",
  // tables as a lazy continuation of a list item (the class the arm was added for)
  "- item one\n| a | b |\n|---|---|\n| c | d |\n\n- item two\n",
  "- x\n  head | only\n  ---|---\n  body | row\n- y\n",
  // container shapes — indent, blockquote, ordered, nested
  "  | a | b |\n  |---|---|\n  | c | d |\n",
  "   | a | b |\n   |---|---|\n",
  "\t| a | b |\n\t|---|---|\n",
  "> | a | b |\n> |---|---|\n\n- item\n\n  | c | d |\n  |---|---|\n\npara\n",
  "> lazy para\n> | a | b |\n> |---|---|\n> | c | d |\n",
  ">| a | b |\n>|---|---|\n",
  "> - quoted list\n>   | a | b |\n>   |---|---|\n",
  "> a | b\n> ---|---\n> c | d\ntrailing lazy\n",
  "- item\n\n  para in item\n  | a | b |\n  |---|---|\n\n- next\n",
  "1. ordered\n   | a | b |\n   |---|---|\n   | c | d |\n",
  "- a\n\n  - b\n\n    | x | y |\n    |---|---|\n\n  - c\n",
  // ⚠️ Load-bearing, and shaped for a SINGLE-CHARACTER edit on purpose — two independent
  // constraints meet here:
  //   1. PIPE-FREE. Every other 4-space-indented line in this corpus is a table row, so the
  //      SHIPPED presence-based TABLE-DELIM arm fires on any edit to it and it never reaches
  //      the arms-silent branch. Without a pipe-free indented line the corpus cannot surface
  //      the ATX-indent hole at all (measured: 224 residuals, every one of them Setext).
  //   2. ONE character of content. A valid ATX marker is `#` followed by whitespace or EOL,
  //      so `    plain text` → `    # plain text` needs TWO inserted characters and the
  //      enumerator only makes one-character edits. With a single `x` as the whole indented
  //      content, the replace `x` → `#` yields `    #` — `#` at EOL, a real heading.
  // Measured: that edit is arms-silent under the shipped guard and flips
  // `Paragraph@L4-L4` to `ATXHeading1@L4-L4`; the relaxed `[ \t]*` SHAPE fires on it.
  "- a\n\n  - b\n\n    x\n\n  - c\n",
  "- outer\n  - inner\n    | a | b |\n    |---|---|\n    | c | d |\n  - after\n",
  "para\n\n    indented code | not table\n    |---|---|\n\npara2\n",
  // delimiter indentation ladder — 0..4 spaces flips what the RAW regex accepts
  "| a | b |\n |---|---|\n| c | d |\n",
  "| a | b |\n  |---|---|\n| c | d |\n",
  "| a | b |\n   |---|---|\n| c | d |\n",
  "| a | b |\n    |---|---|\n| c | d |\n",
  // endLeaf geometry — a paragraph broken by a pipe line whose successor is a delimiter.
  // The whitespace-led `:` forms only because endLeaf tests the RAW peeked line.
  "para\nhead|\n :---|\n",
  "para\nhead|\n|:---|\n",
  "- item\npara\nhead|\n :---|\n\n  cont\n",
  "- item\npara\nhead|\n|:---|\n\n  cont\n",
  "- outer\n  para\n  head|\n  :-|\n\n  tail\n",
  "- outer\n  para\n  head|\n  |:-|\n\n  tail\n",
  "lead para\na | b\n :--- | ---:\nc | d\n\nafter\n",
  "lead para\na | b\n| :--- | ---:\nc | d\n\nafter\n",
  "x|y\n  ---|---\nrow\n",
  "x|y\n  |---|---|\nrow\n",
  // Setext next to a table, images, headings, fence, callout, HTML block
  "prose lead\n| a | b |\n|---|---|\nsetext under\n===\n",
  "![alt](img.png)\n\n| a | b |\n|---|---|\n\n- ![in list](x.png)\n\n![tail](y.png)\n",
  "# h1\n\nsetext title\n===\n\n> [!NOTE]\n> body\n\n```js\ncode | here\n```\n\n<div>\nhtml | block\n</div>\n",
];

// Every character the guard's arms reason about, plus plain prose characters so the
// bounded path is genuinely represented in the census.
const ALPHABET = [
  "|",
  "-",
  ":",
  "=",
  "#",
  ">",
  "`",
  "_",
  "*",
  "+",
  ".",
  "!",
  "[",
  "]",
  "(",
  ")",
  "\\",
  " ",
  "\t",
  "x",
  "0",
] as const;

function lineTextAt(doc: string, pos: number): string {
  const start = doc.lastIndexOf("\n", pos - 1) + 1;
  const end = doc.indexOf("\n", pos) < 0 ? doc.length : doc.indexOf("\n", pos);
  return doc.slice(start, end);
}

export interface SingleCharEdit {
  before: string;
  after: string;
  oldLine: string;
  newLine: string;
  inserted: string;
  deleted: string;
}

/** Every single-character insert / delete / replace at every offset of `doc`. */
export function forEachSingleCharEdit(doc: string, visit: (e: SingleCharEdit) => void): void {
  for (let pos = 0; pos <= doc.length; pos++) {
    for (const ch of ALPHABET) {
      const after = doc.slice(0, pos) + ch + doc.slice(pos);
      visit({
        before: doc,
        after,
        oldLine: lineTextAt(doc, pos),
        newLine: lineTextAt(after, pos),
        inserted: ch,
        deleted: "",
      });
    }
  }
  for (let pos = 0; pos < doc.length; pos++) {
    const deleted = doc[pos] as string;
    const after = doc.slice(0, pos) + doc.slice(pos + 1);
    visit({
      before: doc,
      after,
      oldLine: lineTextAt(doc, pos),
      newLine: lineTextAt(after, Math.min(pos, after.length)),
      inserted: "",
      deleted,
    });
    for (const ch of ALPHABET) {
      if (ch === deleted) {
        continue;
      }
      const replaced = doc.slice(0, pos) + ch + doc.slice(pos + 1);
      visit({
        before: doc,
        after: replaced,
        oldLine: lineTextAt(doc, pos),
        newLine: lineTextAt(replaced, pos),
        inserted: ch,
        deleted,
      });
    }
  }
}
