// Shared Markdown "structural reparse" guard for the changed-range-bounded
// StateFields — any field that recomputes only a WINDOW around the change and
// reuses its records outside it, whether that window is a block's blank-line-
// delimited run or the changed lines plus a neighbour. Every such field assumes a
// block's identity can only change from WITHIN the window it recomputed. Markdown
// block boundaries are NOT stable under edits, so `touchesStructuralReparse` is
// the SOUND over-approximation that routes an edit which could re-shape a boundary
// OUTSIDE that window to a FULL rebuild. Consumers import the PAIRED admission
// test `requiresFullBoundedRebuild` (below) rather than either term on its own or
// a hand-rolled predicate; `git grep requiresFullBoundedRebuild src/` is the live
// consumer list, and no count is kept here because a count goes stale the next time
// a field is added.
//
// Fenced-code collapse (fenced-code/fenced-code-collapse.ts) does NOT import this:
// it keeps a NARROWER STRUCTURAL (no ATX/underscore alts) plus its own
// `topLevelBoundaryRisk` + `insideBlock` record scoping, because its hot path is
// editing INSIDE a code fence — where a `#` comment or `___` line must stay on
// the bounded path. See the STRUCTURAL doc-comment below + docs/LEARNING.md.
//
// The dual old/new line-slice scan is memoised per Transaction (a WeakMap keyed
// on `tr`): in @codemirror/state 6.6.x CodeMirror hands the SAME Transaction to
// every StateField.update() in one dispatch, so every consumer of this predicate
// shares ONE scan. The WeakMap holds `tr` weakly (entries GC with the
// transaction — no eviction, no leak). The sharing is an efficiency win, not a
// correctness dependency: `touchesStructuralReparse` is a pure function of `tr`,
// so if a future CM ever cloned the transaction per field, each field would just
// recompute the same verdict — result unchanged, only the sharing lost.

import { syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState, Transaction } from "@codemirror/state";
import type { Interval } from "./bounded-recompute.js";

/** SHAPE over-approximation for a structural reparse — the fenced field's proven
 *  `STRUCTURAL` regex (`fenced-code-collapse.ts`, the #63 precedent: fence delimiters,
 *  list/blockquote container markers, HTML block openers + the unanchored type-1/2/3/5
 *  terminators) PLUS three alternations the fenced field deliberately omits because they
 *  cannot affect FENCE grouping but DO re-shape the block-window consumers' blocks:
 *   - ATX-heading alt `#{1,6}(?:[ \t]|$)`: an in-place single-line edit `x q`→`# q` makes
 *     a heading interrupt a lazy continuation, closing a list and flipping a far `  # h`
 *     from ListItem to Document (Fable parser-verified, Conf 95). NEWLINE-DELTA below does
 *     NOT cover this single-line case, so the alt is a soundness requirement here.
 *   - underscore thematic-break alt `(?:_[ \t]*){3,}`: `___` opens a thematic break that
 *     terminates a preceding paragraph/list run. The `-`/`*` thematic forms are already
 *     caught by the container-marker alt, so only `_` needs adding.
 *   - Setext-underline alt `=+[ \t]*(?:\n|$)`: typing into a `===` line flips a whole run
 *     between SetextHeading and Table/Paragraph, and no other arm sees it — the line has no
 *     pipe, no newline, no `>`, no blank flip, no indent change (bounded-exhaustive oracle
 *     finding, cm-structural-guard-exhaustive.test.ts). ⚠️ `STRUCTURAL` has NO `m` flag, so a
 *     line end MUST be spelled `(?:\n|$)` — writing `$` anchors to end-of-STRING and silently
 *     matches almost nothing.
 *  Every marker alternation's indent bound is `[ \t]*`, NOT CommonMark's top-level `{0,3}`:
 *  a line's legal marker indent is relative to its CONTAINER's content indent, and inside a
 *  nested list `    # h` IS a real heading — a line-in-isolation regex cannot see the
 *  container, so it must not assume the top-level bound (the container-marker alt already
 *  used `[ \t]*`; the fence / HTML-open / ATX / underscore alts now match it). Both this and
 *  the Setext alt were found by the same bounded-exhaustive oracle: it is a DELIBERATE
 *  conservative regression (a `#`/`` ``` ``/`<tag>`/`___` line indented 4+, or any `===`
 *  line, now full-rebuilds even inside a fenced or indented code block) accepted because no
 *  line-in-isolation regex can tell such a line apart from a real container-relative marker.
 *  Purely syntactic: a false match only costs a full rebuild (speed), never correctness. */
const STRUCTURAL =
  /(?:^|\n)[ \t]*(?:`{3,}|~{3,})|(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)]|>)|(?:^|\n)[ \t]*<[/!?A-Za-z]|<\/(?:script|pre|style|textarea)>|-->|\?>|\]\]>|(?:^|\n)[ \t]*#{1,6}(?:[ \t]|$)|(?:^|\n)[ \t]*(?:_[ \t]*){3,}|(?:^|\n)[ \t]*=+[ \t]*(?:\n|$)/i;

/** A Markdown blank line — the block separator the up/down walk stops at — is one
 *  containing ONLY ASCII spaces / tabs (CommonMark), the set the Lezer parser
 *  treats as insignificant at a block boundary (verified: a space-only line splits
 *  `foo` / `bar\n===` into a Paragraph + a SetextHeading). It deliberately EXCLUDES
 *  U+000B / U+000C / NBSP and every other Unicode space, which the parser keeps as
 *  significant paragraph content (mirrors image-field.ts's `trimAsciiWs`): a line
 *  whose only char is one of those is NOT a boundary, and stopping the walk there
 *  would drop the marker line of a Setext block that spans it → under-recompute.
 *  The common case is a truly-empty line (`""`). */
export function isBlankLine(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

// ---------------------------------------------------------------------------
// TABLE-DELIM inputs — mirrors of @lezer/markdown 1.6.4's own table-formation tests
// (`hasPipe`, `delimiterLine`, `parseRow`). A GFM `Table` exists in that parser iff a leaf
// block's first line has an unescaped pipe, a following line is delimiter-shaped, and the
// two lines' `parseRow` cell counts agree — via `TableParser.nextLine` for the ordinary
// case and via `endLeaf` for a paragraph split by a pipe line.
//
// ⚠️ The parser applies `delimiterLine` at TWO call sites with DIFFERENT inputs:
// `TableParser.nextLine` tests `line.text.slice(line.pos)` (container prefix removed) while
// `endLeaf` tests `cx.peekLine()` RAW. The regex's only whitespace sensitivity is its `^\|?`
// anchor, so over every possible `line.pos` the test takes exactly TWO values — "leading
// whitespace remains" (== raw) and "fully stripped". Both are mirrored, and both are
// compared, because this arm is a DELTA and NOT a presence test: an over-approximating
// predicate that pins BOTH sides to `true` erases a real flip, so here the cost of a false
// match is a MISSED rebuild, not a wasted one. Verified counterexample — ` :---|` →
// ` |:---|` keeps hasPipe, stripped-delimiter and cell count all constant while the table
// (and, through it, an enclosing list's extent across a blank line) disappears.
// `hasPipe` and `parseRow` need no such pairing — but ONLY because of a CROSS-ARM
// dependency that must not be silently removed: the parser starts them at `line.basePos`
// while these mirrors start at 0, which agrees exactly when `[0, basePos)` is whitespace.
// For a line whose prefix is a CONTAINER MARKER it does NOT agree (`> | b` counts 1 to the
// parser and 2 here, so `> | b` -> `> x | b` flips for the parser and not for the mirror),
// and that is harmless solely because SHAPE's container alternation
// `(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)]|>)` fires on every such line before this arm is
// reached. ⚠️ Narrowing SHAPE's container alternation would make these mirrors unsound
// without touching them; see the SHAPE follow-up entry in TODO.md. Drift in any of this is
// caught by cm-lezer-table-internals-tripwire.test.ts; the arm's overall soundness is
// measured by cm-structural-guard-exhaustive.test.ts.

/** Mirror of `hasPipe`: an unescaped `|` anywhere; `\` escapes the next character. */
function hasUnescapedPipe(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const next = text.charCodeAt(i);
    if (next === 124 /* '|' */) {
      return true;
    }
    if (next === 92 /* '\' */) {
      i++;
    }
  }
  return false;
}

/** @lezer/markdown 1.6.4's `delimiterLine` regex, VERBATIM. */
const TABLE_DELIMITER_LINE = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;

/** Mirror of `parseRow`'s return value: cells split on unescaped `|`; a leading pipe opens
 *  no cell and a trailing pipe closes none; a run of only spaces/tabs is not content.
 *  Counting raw `|` characters instead would MISS `a | b` → `  | b`, which drops the count
 *  2 → 1 with the pipe count unchanged — a header edit that breaks a whole table. */
function tableRowCellCount(text: string): number {
  let count = 0;
  let first = true;
  let cellStart = -1;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const next = text.charCodeAt(i);
    if (next === 124 /* '|' */ && !esc) {
      if (!first || cellStart > -1) {
        count++;
      }
      first = false;
      cellStart = -1;
    } else if (esc || (next !== 32 && next !== 9)) {
      if (cellStart < 0) {
        cellStart = i;
      }
    }
    esc = !esc && next === 92 /* '\' */;
  }
  if (cellStart > -1) {
    count++;
  }
  return count;
}

/** The narrowed TABLE-DELIM arm: did this single-line edit change any of the FOUR facts
 *  lezer forms a `Table` from? Exported so the shape test can pin it directly. */
export function tableRowShapeChanged(oldText: string, newText: string): boolean {
  return (
    hasUnescapedPipe(oldText) !== hasUnescapedPipe(newText) ||
    TABLE_DELIMITER_LINE.test(oldText) !== TABLE_DELIMITER_LINE.test(newText) ||
    TABLE_DELIMITER_LINE.test(oldText.replace(/^[ \t]+/, "")) !==
      TABLE_DELIMITER_LINE.test(newText.replace(/^[ \t]+/, "")) ||
    tableRowCellCount(oldText) !== tableRowCellCount(newText)
  );
}

/** SOUND syntactic over-approximation of "this edit could trigger a STRUCTURAL REPARSE
 *  that re-shapes a block boundary OUTSIDE the changed window". Some consumers bound their
 *  keystroke recompute to the changed blank-line-delimited run (`expandToEnclosingBlock`);
 *  others bound it to the changed lines plus a neighbour. Either way, the field assumes a
 *  block's identity can only change from WITHIN the window it recomputed. Markdown block
 *  boundaries are NOT stable under edits, so that assumption
 *  can strand/miss a fold chevron: an unclosed ``` fence swallows the blocks below it; a
 *  `<!DOCTYPE …>` type-4 HTML declaration swallows until its `>`; un-listing (`- a`→`a`)
 *  re-contexts a nested `  # h` to top-level; etc. When this fires, the field falls back to
 *  a FULL rebuild so a structural edit never leaves a stranded/missing chevron.
 *
 *  Mirrors the fenced field's guard (`touchesStructural` dual old/new line-expanded slice
 *  scan + `topLevelBoundaryRisk`'s newline/`>`/blank arms), FOLDED into one pass and with
 *  NO `insideBlock` gate: unlike the fenced field, this guard does not scope a trigger
 *  against a consumer's own reused per-block record, so ANY top-level structural trigger
 *  ⇒ full rebuild regardless of whether a given consumer holds reusable records at all.
 *  Fires when, for ANY changed range, ANY arm matches:
 *   - SHAPE — STRUCTURAL matches the OLD or NEW line-expanded slice.
 *   - NEWLINE-DELTA — the edit inserts or deletes a `\n`. A multi-line interior edit can
 *     promote/demote a FAR heading or terminate an enclosing list while its endpoints stay
 *     shapeless (endpoint-only SHAPE/blank/indent checks miss it). Cost is Enter/paste/
 *     line-delete only — single-char prose typing never trips it.
 *   - GT-DELTA — the edit adds or removes a `>`. A bare `>` terminates a type-4
 *     `<!DOCTYPE …>` declaration (a same-line, non-newline, non-shape edit that SHAPE and
 *     the other arms all miss); keying on the `>` being ADDED/REMOVED (not merely present)
 *     keeps it narrow (mirrors the fenced field's cycle-5 type-4 rationale).
 *   - TABLE-DELIM — a GFM table delimiter row completing/breaking via a single-char edit
 *     (`|--x|`→`|---|`) can CLOSE an enclosing list, re-shaping a boundary OUTSIDE the
 *     changed run (a same-line, non-newline, non-shape edit the other arms all miss); fires
 *     on any `|` present in the changed line's OLD or NEW slice (presence-based, like SHAPE).
 *   - BLANK-FLIP — the changed line's blankness flips old↔new (single-line, since
 *     NEWLINE-DELTA already caught every multi-line edit). A blank line terminates a
 *     paragraph / loose list / type-6/7 HTML block between a far heading and its context.
 *   - INDENT-DELTA — the changed line's leading-whitespace prefix differs old↔new
 *     (single-line). `  x`→`x` flips whether an intervening run continues an enclosing
 *     loose list item, flipping a far `  # h` between list-content and top-level.
 *  On a non-docChanged transaction `iterChangedRanges` yields nothing → returns false.
 *
 *  SOUND over-approximation: false full-rebuilds only cost speed; UNDER-triggering would be
 *  unsound (a stranded chevron). ACCEPTED over-approximation (perf, not soundness): SHAPE and
 *  TABLE-DELIM are presence-based, so editing the BODY of a line that already starts with a
 *  marker (`- item`→`- itemx`) or sits inside a table row trips a full rebuild even though
 *  structure is unchanged. What that costs depends on the consumer's PRE-guard baseline:
 *   - For the fold / callout consumers this guard was written for, the baseline was an
 *     always-full rebuild, so presence-based firing is a strict improvement.
 *   - For `image/image-field.ts` and `table/table-skeleton.ts`, which admitted on the
 *     frontier term alone before they adopted this pair, the baseline was always-BOUNDED, so
 *     it is a REGRESSION on the keystroke classes that now fire: typing in a list-item body,
 *     a blockquote line, a table cell or an ATX heading, and every Enter. EACH field's own
 *     full-walk cost was measured on its own fixtures and accepted for this PR — separately,
 *     because the two cost curves differ in SHAPE: the table field's grows with document
 *     size (its full walk re-runs `parseTable` per node), the image field's is essentially
 *     flat — for a reason that was NOT isolated. It is specifically NOT reuse: the image
 *     field's full walk re-derives alt/safeUrl/slice fresh per node (`buildRange` takes no
 *     `prev`); the reuse lives only on `computeBounded`'s position-shift branch. Sharing
 *     this guard and this trigger set does NOT imply sharing a cost, so neither number may
 *     be inferred from the other. Numbers: PERF.md; scoping follow-up: TODO.md.
 *  A delta-based / per-consumer refinement is deferred to that follow-up
 *  (`fenced-code-collapse.ts`'s `insideBlock` + `topLevelBoundaryRisk` is the in-repo
 *  precedent). Exported so the negative-assertion tests can call it
 *  directly (pinning that plain prose typing stays on the bounded hot path).
 *  Memoised per Transaction so every consumer shares one dual-slice scan per
 *  dispatch (one scan per dispatch under CM 6.6.x). */
const structuralMemo = new WeakMap<Transaction, boolean>();
export function touchesStructuralReparse(tr: Transaction): boolean {
  const cached = structuralMemo.get(tr);
  if (cached !== undefined) {
    return cached;
  }
  let hit = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (hit) {
      return;
    }
    const oldSlice = tr.startState.doc.sliceString(
      tr.startState.doc.lineAt(fromA).from,
      tr.startState.doc.lineAt(toA).to
    );
    const newSlice = tr.state.doc.sliceString(
      tr.state.doc.lineAt(fromB).from,
      tr.state.doc.lineAt(toB).to
    );
    if (STRUCTURAL.test(oldSlice) || STRUCTURAL.test(newSlice)) {
      hit = true;
      return;
    }
    const insertedText = tr.state.doc.sliceString(fromB, toB);
    const deletedText = tr.startState.doc.sliceString(fromA, toA);
    if (insertedText.includes("\n") || deletedText.includes("\n")) {
      hit = true;
      return;
    }
    if (insertedText.includes(">") || deletedText.includes(">")) {
      hit = true;
      return;
    }
    // TABLE-DELIM — a GFM table delimiter row completing / breaking via a
    // single-char edit (`|--x|`→`|---|`) interrupts a lazy continuation and can
    // CLOSE an enclosing list while FORMING a Table, re-shaping the block
    // structure OUTSIDE the changed run — a same-line, non-newline, non-shape
    // edit that SHAPE and the other arms all miss (it splits a list / forms a
    // table block that the bounded consumers read). Over-approximate
    // on any `|` in the changed line (a table cell/delimiter separator); a false
    // match only costs a full rebuild (speed), never correctness — same contract
    // as the other arms. Completeness is also guaranteed at the parser level:
    // @lezer/markdown's `delimiterLine` regex requires a `|` (its `(…\|)+` group)
    // and a table header needs an unescaped `|` (`hasPipe`), so no pipeless table
    // row can slip past this arm. SLICE-based (not insert/delete-delta like
    // GT-DELTA) so a pipe-escape edit `a|b`→`a\|b` still fires (slice keeps `|`).
    if (oldSlice.includes("|") || newSlice.includes("|")) {
      hit = true;
      return;
    }
    const oldLine = tr.startState.doc.lineAt(fromA);
    const newLine = tr.state.doc.lineAt(fromB);
    if (isBlankLine(oldLine.text) !== isBlankLine(newLine.text)) {
      hit = true;
      return;
    }
    const oldIndent = /^[ \t]*/.exec(oldLine.text)?.[0] ?? "";
    const newIndent = /^[ \t]*/.exec(newLine.text)?.[0] ?? "";
    if (oldIndent !== newIndent) {
      hit = true;
    }
  });
  structuralMemo.set(tr, hit);
  return hit;
}

/** The admission test every changed-range-bounded StateField applies on a docChanged
 *  transaction before it may reuse records: take the FULL rebuild when either the edit
 *  could re-shape a block boundary outside the recomputed window (`touchesStructuralReparse`
 *  — see above), or the post-edit parse frontier is incomplete so the tree cannot be
 *  trusted outside it (G2).
 *
 *  The two terms answer DIFFERENT questions and neither implies the other: a structural
 *  reparse happens with a COMPLETE frontier, and a starved frontier happens on edits with
 *  no structural shape at all. Spelling them out per field is what let two fields ship with
 *  only the second — so this is the only spelling, and
 *  test/build/frontier-gate-needs-structural-guard.test.ts is what keeps it that way.
 *
 *  Callers may OR their own extra risks IN FRONT of this (fold/index.ts adds a facet flip);
 *  what they must not do is take either term away. */
export function requiresFullBoundedRebuild(tr: Transaction): boolean {
  return touchesStructuralReparse(tr) || !syntaxTreeAvailable(tr.state, tr.state.doc.length);
}

/** Expand [from,to] to the enclosing blank-line-delimited block: line-align, then
 *  walk out through contiguous non-blank lines in BOTH directions. A heading's
 *  gutter tag rides the FIRST line of its (possibly multi-line Setext) block, and
 *  a block's heading-ness can only change from WITHIN that same non-blank run — so
 *  the whole run is exactly the region a change can flip. The up-walk is load-
 *  bearing: a Setext underline (`===` / `---`) typed several lines BELOW its title
 *  turns the whole paragraph into a heading whose marker sits on the FIRST line, a
 *  case a naive ±1-line window (image-field.ts's single-line-image G1) would miss.
 *  The stop predicate is `isBlankLine` (ASCII space/tab only), matching the parser's
 *  block boundaries exactly: a whitespace-CONTAMINATED blank line still stops the
 *  walk, so a keystroke never over-expands across such a separator into unrelated
 *  blocks (which would resurrect the whole-doc cost this bounding removes). Reads
 *  post-edit `state`, so a merged/split block is measured at its new extent (a
 *  deleted blank line makes two former blocks one contiguous run the walk spans).
 *  Exported for the block-boundary contract test. */
export function expandToEnclosingBlock(state: EditorState, from: number, to: number): Interval {
  const doc = state.doc;
  const len = doc.length;
  let top = doc.lineAt(Math.max(0, Math.min(from, len)));
  while (top.from > 0) {
    const prev = doc.lineAt(top.from - 1);
    if (isBlankLine(prev.text)) {
      break;
    }
    top = prev;
  }
  let bottom = doc.lineAt(Math.max(0, Math.min(to, len)));
  while (bottom.to < len) {
    const next = doc.lineAt(bottom.to + 1);
    if (isBlankLine(next.text)) {
      break;
    }
    bottom = next;
  }
  return { from: top.from, to: bottom.to };
}
