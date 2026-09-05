// Corpus + edit enumerator shared by the structural-guard proofs.
//
// The enumeration is BOUNDED-EXHAUSTIVE, not random: every single-character insert,
// delete and replace at every offset of every document. That is the only shape of
// evidence that reaches this bug class — the counterexample that broke rev. 1 of the
// plan needs a specific document geometry AND one specific offset, which a uniform
// random fuzz finds with probability ≈ 0 (Fable review, 2026-09-05). It is also cheap:
// the whole enumeration parses in a few seconds (91,471 edits at the time of writing;
// the oracle prints its own `checked=` count, which is the number to trust over this one).
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
  // ⚠️ Load-bearing for the ATX-indent class, together with the two `    | x | y |`
  // documents above and below it. Shaped for a SINGLE-CHARACTER edit on purpose: a valid ATX
  // marker is `#` followed by whitespace or EOL, so `    plain text` → `    # plain text`
  // needs TWO inserted characters and this enumerator only makes one. With a single `x` as
  // the whole indented content, the replace `x` → `#` yields `    #` — `#` at EOL, a real
  // heading — and it is arms-silent under the pre-relaxation guard, flipping
  // `Paragraph@L4-L4` to `ATXHeading1@L4-L4`; the relaxed `[ \t]*` SHAPE fires on it.
  // Measured against the SHIPPED narrowed TABLE-DELIM arm: tightening the ATX alternation
  // back to CommonMark's ` {0,3}` yields 4 residuals spread over THREE documents, this one
  // and the two pipe-bearing ones — an indented `|`→`#` replace can keep the table facts
  // constant, so a pipe on the line no longer forces the full arm by itself. (The
  // `224 residuals, every one of them Setext` figure belongs to the SETEXT-alternation
  // mutation, not to this one.) Keep the line anyway: with a single `x` as the whole
  // indented content it is still the cheapest carrier of the case for a ONE-character edit.
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
  // ⚠️ Also the carrier for the `\s`-vs-`skipSpace` class, in combination with the Unicode
  // whitespace in ALPHABET below: `delimiterLine`'s `\s` accepts NBSP / U+3000 / `\f` / `\v`
  // while `TableParser.nextLine` reaches that regex only behind `line.next ∈ {-,:,|}`, and
  // lezer's `skipSpace` advances over charCodes 32/9 ONLY. So inserting one of those
  // characters at the head of this delimiter line moves the two call sites apart — a class
  // no ASCII-only alphabet can enumerate.
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
  // endLeaf's BORROWED basePos — the delimiter line is a LAZY CONTINUATION that is LESS
  // indented than its header, so `parseRow(cx, next, line.basePos)` measures it from the
  // HEADER's basePos and `[0, basePos)` of the delimiter line is table BYTES (`|-`), neither
  // whitespace nor a container marker. A one-character edit inside the delimiter run
  // (`|--|-` → `|- |-`) deletes the whole `Table` while an offset-0 four-fact delta stays
  // constant — reproduced against the real parser, 2026-09-06. This is the geometry the
  // PRESENCE retreat in `tableRowShapeChanged` exists for, and ONE line carries it: no other
  // entry pairs an indented header with a less-indented delimiter. Measured, so it stays at
  // one: revert the retreat to the pre-2026-09-06 four-fact delta AND drop the Unicode
  // whitespace from ALPHABET (which isolates this class from the `\s`-vs-`skipSpace` one),
  // and the oracle reports 4 residuals, ALL of them on THIS document. A second
  // lazy-continuation document was tried and dropped again — 2,201 extra enumerated edits,
  // and no class it was the only carrier of (ablation, 2026-09-06).
  "- l\n  h | e\n|--|-\n  r1\n  r2\n",
  // Setext next to a table, images, headings, fence, callout, HTML block
  "prose lead\n| a | b |\n|---|---|\nsetext under\n===\n",
  "![alt](img.png)\n\n| a | b |\n|---|---|\n\n- ![in list](x.png)\n\n![tail](y.png)\n",
  "# h1\n\nsetext title\n===\n\n> [!NOTE]\n> body\n\n```js\ncode | here\n```\n\n<div>\nhtml | block\n</div>\n",
];

// Every character the guard's arms reason about, plus plain prose characters so the
// bounded path is genuinely represented in the census.
// ⚠️ The four NON-ASCII whitespace entries are load-bearing, not padding: `delimiterLine`'s
// `\s` accepts NBSP / U+3000 / `\f` / `\v` while lezer's `skipSpace` — which decides the
// `line.next ∈ {-,:,|}` gate in front of that regex — advances over charCodes 32/9 only.
// With `" "` and `"\t"` alone the oracle cannot enumerate any edit that separates the two,
// so the whole `\s`-vs-`skipSpace` class is invisible to it (measured: the class was found
// by reading the parser, not by this corpus, 2026-09-06). `isBlankLine` deliberately
// excludes the same set, so they also exercise BLANK-FLIP's boundary.
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
  // Spelled as escapes on purpose: a literal NBSP / U+3000 in source is invisible in a diff
  // and indistinguishable from the plain `" "` two entries above.
  "\u00a0",
  "\u3000",
  "\f",
  "\v",
  "x",
  "0",
] as const;

export interface SingleCharEdit {
  after: string;
  /** The ENUMERATED edit offset — `changes: { from: pos, to: pos + deleted.length,
   *  insert: inserted }`. Carried rather than re-derived by the consumer: a first-difference
   *  scan lands on a DIFFERENT offset inside a run of identical characters (measured
   *  2026-09-06 over the then-75,750-edit enumeration: 1,277 edits diverged, 30 of them onto
   *  a different LINE; the corpus has grown since, so read the ratio, not the totals). The resulting document is the
   *  same either way today, so nothing was red — which is precisely why the offset is
   *  exported instead of left to be guessed. */
  pos: number;
  inserted: string;
  deleted: string;
}

/** Every single-character insert / delete / replace at every offset of `doc`. */
export function forEachSingleCharEdit(doc: string, visit: (e: SingleCharEdit) => void): void {
  for (let pos = 0; pos <= doc.length; pos++) {
    for (const ch of ALPHABET) {
      visit({
        after: doc.slice(0, pos) + ch + doc.slice(pos),
        pos,
        inserted: ch,
        deleted: "",
      });
    }
  }
  for (let pos = 0; pos < doc.length; pos++) {
    const deleted = doc[pos] as string;
    visit({
      after: doc.slice(0, pos) + doc.slice(pos + 1),
      pos,
      inserted: "",
      deleted,
    });
    for (const ch of ALPHABET) {
      if (ch === deleted) {
        continue;
      }
      visit({
        after: doc.slice(0, pos) + ch + doc.slice(pos + 1),
        pos,
        inserted: ch,
        deleted,
      });
    }
  }
}
