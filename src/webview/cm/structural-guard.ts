// Shared Markdown "structural reparse" guard for the changed-range-bounded
// StateFields that key their keystroke recompute off a block's blank-line-
// delimited run (the three fold-gutter fields in fold/index.ts + the callout
// marker-conceal field). These fields assume a block's identity can only change
// from WITHIN its own run; Markdown block boundaries are NOT stable under edits,
// so `touchesStructuralReparse` is the SOUND over-approximation that routes an
// edit which could re-shape a boundary OUTSIDE the changed run to a FULL rebuild.
//
// Fenced-code collapse (fenced-code/fenced-code-collapse.ts) does NOT import this:
// it keeps a NARROWER STRUCTURAL (no ATX/underscore alts) plus its own
// `topLevelBoundaryRisk` + `insideBlock` record scoping, because its hot path is
// editing INSIDE a code fence — where a `#` comment or `___` line must stay on
// the bounded path. See the STRUCTURAL doc-comment below + docs/LEARNING.md.
//
// The dual old/new line-slice scan is memoised per Transaction (a WeakMap keyed
// on `tr`): in @codemirror/state 6.6.x CodeMirror hands the SAME Transaction to
// every StateField.update() in one dispatch, so the four fold/callout fields share
// ONE scan per keystroke. The WeakMap holds `tr` weakly (entries GC with the
// transaction — no eviction, no leak). The sharing is an efficiency win, not a
// correctness dependency: `touchesStructuralReparse` is a pure function of `tr`,
// so if a future CM ever cloned the transaction per field, each field would just
// recompute the same verdict — result unchanged, only the sharing lost.

import type { EditorState, Transaction } from "@codemirror/state";
import type { Interval } from "./bounded-recompute.js";

/** SHAPE over-approximation for a structural reparse — the fenced field's proven
 *  `STRUCTURAL` regex (`fenced-code-collapse.ts`, the #63 precedent: fence delimiters,
 *  list/blockquote container markers, HTML block openers + the unanchored type-1/2/3/5
 *  terminators) PLUS two alternations the fenced field deliberately omits because they
 *  cannot affect FENCE grouping but DO re-shape the fold fields' blocks:
 *   - ATX-heading alt `#{1,6}(?:[ \t]|$)`: an in-place single-line edit `x q`→`# q` makes
 *     a heading interrupt a lazy continuation, closing a list and flipping a far `  # h`
 *     from ListItem to Document (Fable parser-verified, Conf 95). NEWLINE-DELTA below does
 *     NOT cover this single-line case, so the alt is a soundness requirement here.
 *   - underscore thematic-break alt `(?:_[ \t]*){3,}`: `___` opens a thematic break that
 *     terminates a preceding paragraph/list run. The `-`/`*` thematic forms are already
 *     caught by the container-marker alt, so only `_` needs adding.
 *  Purely syntactic: a false match only costs a full rebuild (speed), never correctness. */
const STRUCTURAL =
  /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})|(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)]|>)|(?:^|\n)[ \t]{0,3}<[/!?A-Za-z]|<\/(?:script|pre|style|textarea)>|-->|\?>|\]\]>|(?:^|\n)[ \t]{0,3}#{1,6}(?:[ \t]|$)|(?:^|\n)[ \t]{0,3}(?:_[ \t]*){3,}/i;

/** Global-flag twin of STRUCTURAL (same source — single source of truth) for the
 *  DELTA scan: `String.prototype.match` with a `g`-flagged regex returns every
 *  match substring and is stateless (no `lastIndex` carry-over between calls,
 *  unlike `.test`/`.exec`). Non-capturing groups ⇒ the array holds full matches. */
const STRUCTURAL_GLOBAL = new RegExp(STRUCTURAL.source, "gi");

/** The ordered structural-marker SIGNATURE of a line-expanded slice: the sequence of
 *  STRUCTURAL matches (fence/container/HTML markers + inline terminators). Two slices
 *  with the SAME signature carry the same block-shaping markers in the same order, so an
 *  edit between them cannot open/close/re-delimit a container that reaches OUTSIDE the
 *  changed run. Comparing old↔new signatures (rather than mere presence) is what lets a
 *  marker-BODY edit (`- item`→`- itemx`) stay bounded. */
function structuralSignature(slice: string): string {
  return (slice.match(STRUCTURAL_GLOBAL) ?? []).join("\n");
}

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

/** SOUND syntactic over-approximation of "this edit could trigger a STRUCTURAL REPARSE
 *  that re-shapes a block boundary OUTSIDE the changed run". The three fold-gutter fields
 *  bound their keystroke recompute to the changed blank-line-delimited run
 *  (`expandToEnclosingBlock`), which assumes a block's identity can only change from WITHIN
 *  its own run. Markdown block boundaries are NOT stable under edits, so that assumption
 *  can strand/miss a fold chevron: an unclosed ``` fence swallows the blocks below it; a
 *  `<!DOCTYPE …>` type-4 HTML declaration swallows until its `>`; un-listing (`- a`→`a`)
 *  re-contexts a nested `  # h` to top-level; etc. When this fires, the field falls back to
 *  a FULL rebuild so a structural edit never leaves a stranded/missing chevron.
 *
 *  Mirrors the fenced field's guard (`touchesStructural` dual old/new line-expanded slice
 *  scan + `topLevelBoundaryRisk`'s newline/`>`/blank arms), FOLDED into one pass and with
 *  NO `insideBlock` gate: the fold fields are record-less (no reused per-block record to
 *  scope an in-body edit against), so ANY top-level structural trigger ⇒ full rebuild.
 *  Fires when, for ANY changed range, ANY arm matches:
 *   - SHAPE — the STRUCTURAL marker SIGNATURE (ordered match sequence) of the OLD line-
 *     expanded slice DIFFERS from the NEW one. A marker appearing, vanishing, or changing
 *     shape (`x q`→`# q`, `- a`→`a`, ``` ``` ```→``` ````` ```) re-delimits a container that
 *     can reach outside the changed run. Delta-based, NOT presence-based: a marker-BODY edit
 *     (`- item`→`- itemx`) leaves the signature intact and stays bounded.
 *   - NEWLINE-DELTA — the edit inserts or deletes a `\n`. A multi-line interior edit can
 *     promote/demote a FAR heading or terminate an enclosing list while its endpoints stay
 *     shapeless (endpoint-only SHAPE/blank/indent checks miss it). Cost is Enter/paste/
 *     line-delete only — single-char prose typing never trips it.
 *   - GT-DELTA — the edit adds or removes a `>`. A bare `>` terminates a type-4
 *     `<!DOCTYPE …>` declaration (a same-line, non-newline, non-shape edit that SHAPE and
 *     the other arms all miss); keying on the `>` being ADDED/REMOVED (not merely present)
 *     keeps it narrow (mirrors the fenced field's cycle-5 type-4 rationale).
 *   - BLANK-FLIP — the changed line's blankness flips old↔new (single-line, since
 *     NEWLINE-DELTA already caught every multi-line edit). A blank line terminates a
 *     paragraph / loose list / type-6/7 HTML block between a far heading and its context.
 *   - INDENT-DELTA — the changed line's leading-whitespace prefix differs old↔new
 *     (single-line). `  x`→`x` flips whether an intervening run continues an enclosing
 *     loose list item, flipping a far `  # h` between list-content and top-level.
 *  On a non-docChanged transaction `iterChangedRanges` yields nothing → returns false.
 *
 *  SOUND over-approximation: false full-rebuilds only cost speed; UNDER-triggering would be
 *  unsound (a stranded chevron). SHAPE is DELTA-based (old↔new marker-signature diff), so a
 *  marker-BODY edit (`- item`→`- itemx`) that leaves the block-shaping markers intact stays
 *  on the bounded hot path; it still fires whenever a marker appears, vanishes, or changes
 *  shape. (NOTE — a further, field-SPECIFIC refinement is deferred: the record-carrying
 *  `calloutMarkerConcealField` could keep a NEWLINE/GT/INDENT-DELTA edit contained within an
 *  existing callout record on its bounded path, but that needs a record-aware guard local to
 *  that field, NOT a change to this field-agnostic, record-less shared over-approximation.)
 *  Exported so the negative-assertion tests can call it directly (pinning that plain prose
 *  typing AND marker-body edits stay on the bounded hot path).
 *  Memoised per Transaction so the four fold/callout fields share one dual-slice scan per
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
    if (structuralSignature(oldSlice) !== structuralSignature(newSlice)) {
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
