// First client of the shared collapse reducer (../collapse/line-collapse-field.ts): this file
// keeps the fenced-specific doc-change invalidation policy and wires the spec.
// StateField that collapses long TOP-LEVEL fenced code blocks: bodies with more
// than COLLAPSE_THRESHOLD lines render their first 10 lines plus a "Show more" bar,
// with the rest concealed by a block Decoration.replace. Expansion is sticky (a
// per-block Set of expanded keys, default empty = all collapsed) and is also
// auto-driven when the selection head lands inside a concealed region (mirrors
// CodeMirror's native fold auto-unfold, so the caret can never be trapped).
//
// Block widgets MUST come from a StateField — CodeMirror throws on a ViewPlugin
// `block: true` Decoration.replace (see CLAUDE.md block-widget invariant + memory
// quoll-cm-block-widgets-must-be-statefield).
//
// Display-only: decorations only, never a document change → byte-identical
// round-trip, no `edit` posted (parity with every other fenced-code widget). The
// field deliberately does NOT contribute to quollBlockReplaceZones: the concealed
// zone is non-atomic, and reachability is the auto-expand's job — not the generic
// blockZoneArrowKeymap's.

import { syntaxTreeAvailable } from "@codemirror/language";
import type { EditorState, Transaction } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { type Interval, lineExpandWithNeighbours, mergeIntervals } from "../bounded-recompute.js";
import {
  buildCollapseState,
  type CollapseRecord,
  defineLineCollapseField,
  type LineCollapseSpec,
} from "../collapse/line-collapse-field.js";
import { fencedCollapseTarget } from "./fenced-code-collapse-state.js";
import { FencedCollapseToggleWidget } from "./fenced-code-collapse-widget.js";

/** Public helper kept for the existing unit tests — a thin projection of the full
 *  state (decorations + a fresh copy of the reconciled live expanded-key set). */
export function buildFencedCollapse(
  state: EditorState,
  expanded: ReadonlySet<number>
): { decorations: DecorationSet; liveExpanded: Set<number> } {
  const s = buildCollapseState(fencedCollapseSpec, state, expanded);
  return { decorations: s.decorations, liveExpanded: new Set(s.expanded) };
}

/** GF — fence pairing AND top-level eligibility are non-local:
 *  1. a line becoming/ceasing to be a fence delimiter (```/~~~, ≤3 leading spaces/tabs)
 *     re-pairs fences arbitrarily far away;
 *  2. a line gaining/losing a LIST or BLOCKQUOTE marker changes whether a fence is
 *     container-nested (skipped) or top-level (collapsible) — WITHOUT touching the
 *     fence's own bytes (Codex finding 1).
 *  3. a line that opens or closes an HTML block (e.g. `<script>`, `<!--`, `</script>`,
 *     `-->`) can swallow a following top-level fence WITHOUT touching the fence's bytes:
 *     an unclosed <script>/<!--/<?/<![CDATA[ block, or a type-6/7 tag block, absorbs the
 *     fence into the HTMLBlock node, making it invisible to the top-level tree walk.
 *     HTML START conditions are line-anchored (the `<[/!?A-Za-z]` alt); the multi-char
 *     ENDS can appear MID-LINE, so `</script|pre|style|textarea>` (type 1, case-insensitive)
 *     and `-->` / `?>` / `]]>` (types 2/3/5) are UNanchored. The type-4 bare `>` end
 *     (`<!DOCTYPE …>`) is NOT put here (a bare `>` would match nearly every line); it is
 *     instead handled by `topLevelBoundaryRisk`'s `>`-delta check (fires only when the edit
 *     ADDS/REMOVES a `>` at top level), so every HTML-block terminator is now covered.
 *  STRUCTURAL is a purely SYNTACTIC over-approximation on changed-line text: it
 *  deliberately over-triggers on any fence-shaped, container-marker-shaped, or
 *  HTML-tag-shaped changed line (safe — a false full-recompute only costs speed;
 *  under-triggering is unsound). The hot path stays bounded only for edits whose
 *  changed lines carry none of those shapes (plain code body or plain prose — which the
 *  fenced-heavy perf case is).
 *  BLANK-LINE boundaries are the one non-locality STRUCTURAL cannot see (a blank line
 *  carries no shape): a type-6/7 HTML block (and a paragraph / loose list) is TERMINATED
 *  by a blank line, so MOVING the blank line that ends an HTML block extends/contracts it
 *  over a following top-level fence WITHOUT touching any tag/marker line (Codex cycle-2/3,
 *  both parser-verified). `topLevelBoundaryRisk` covers this: any TOP-LEVEL edit that moves a
 *  blank-line boundary — a newline inserted/deleted, OR a changed line's blankness flipped
 *  in EITHER direction (deleting a line's content down to blank, OR typing into the blank
 *  line that ends the block) — full-recomputes. Fences/lists themselves are
 *  indentation-pinned and do NOT re-group on blank-line edits (parser-probed), but HTML
 *  blocks do, so the guard is scoped to blank-boundary MOVEMENT rather than every fence.
 *  "Top-level" (not inside a reused block's [blockFrom, blockTo]) keeps IN-BODY newlines
 *  bounded — an in-body edit is contained (its own block rebuilds via touchesRange, and
 *  un-closing its fence is caught by STRUCTURAL's fence alt), so writing code stays fast;
 *  and a pure non-newline insertion never moves a blank boundary, so plain typing stays
 *  bounded. G2 + the background-parse self-heal remain as defense-in-depth. */
const STRUCTURAL =
  /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})|(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)]|>)|(?:^|\n)[ \t]{0,3}<[/!?A-Za-z]|<\/(?:script|pre|style|textarea)>|-->|\?>|\]\]>/i;
function touchesStructural(tr: Transaction): boolean {
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
    }
  });
  return hit;
}

const BLANK_LINE = /^[ \t]*$/;

/** A block boundary MOVED by a TOP-LEVEL edit in a way STRUCTURAL's per-line-SHAPE check
 *  cannot see. Two shapeless HTML-block terminators drive this:
 *   - a BLANK line ends a type-6/7 block (and a paragraph / loose list): moving the blank
 *     that ends an HTML block extends/contracts it over a following top-level fence WITHOUT
 *     touching a tag/marker line (Codex cycle-2 + cycle-3, parser-verified).
 *   - a bare `>` ends a type-4 declaration (`<!DOCTYPE …>`): adding/removing that `>` mid-
 *     line likewise re-extends the block (Codex cycle-5, parser-verified). A bare `>` cannot
 *     go in STRUCTURAL (it would match nearly every HTML/prose line — massive over-trigger),
 *     but keying on the `>` being ADDED/REMOVED by the edit — not merely present on the line
 *     — is narrow: it fires only when the user actually types or deletes a `>`.
 *  Fires when the edit changes the LINE COUNT (a newline inserted/deleted), OR flips a
 *  changed line's blankness in EITHER direction (delete-to-blank, or type-into-the-blank),
 *  OR adds/removes a `>`. All three are conservative supersets (e.g. a newline splitting
 *  non-blank prose, or a `>` typed in plain prose, reshapes nothing — a safe over-trigger).
 *  Any within-line edit that keeps the line's blankness, adds/removes no newline, and
 *  touches no `>` cannot move a boundary, so plain typing stays on the bounded hot path.
 *  Fires ONLY when the edit is NOT fully inside a reused block's [blockFrom, blockTo] — an
 *  in-body edit is contained (its own block rebuilds via touchesRange, and un-closing its
 *  fence is caught by STRUCTURAL's fence alt), so in-body edits stay bounded.
 *  ACCEPTED over-trigger (Codex cycle-6): the `>`-delta also fires when a top-level prose
 *  edit merely types/deletes a `>` (`a > b`) with no declaration in play. This is a SAFE
 *  full-recompute and shares the exact top-level gate as the newline/blank arms, so it
 *  NEVER fires on the fenced-heavy hot path (in-fence editing) and is strictly rarer than
 *  the top-level-newline full-recompute already accepted above — worth full soundness. A
 *  precise gate (scan back for an unterminated `<![A-Z]` declaration) was rejected as
 *  disproportionate for a construct that is essentially absent from real Markdown. */
function topLevelBoundaryRisk(
  tr: Transaction,
  prevBlocks: readonly CollapseRecord<null>[]
): boolean {
  let risk = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (risk) {
      return;
    }
    const insertedText = tr.state.doc.sliceString(fromB, toB);
    const deletedText = tr.startState.doc.sliceString(fromA, toA);
    const newlineDelta = insertedText.includes("\n") || deletedText.includes("\n");
    const gtDelta = insertedText.includes(">") || deletedText.includes(">");
    const oldBlank = BLANK_LINE.test(tr.startState.doc.lineAt(fromA).text);
    const newBlank = BLANK_LINE.test(tr.state.doc.lineAt(fromB).text);
    if (!newlineDelta && !gtDelta && oldBlank === newBlank) {
      return; // boundary-inert: no line count change, no blankness flip, no `>` delta
    }
    const insideBlock = prevBlocks.some((b) => fromA >= b.blockFrom && toA <= b.blockTo);
    if (!insideBlock) {
      risk = true;
    }
  });
  return risk;
}

/** Changed range(s) ∪ old/new selection ranges, each line-expanded (±1). Selection
 *  ranges are included so a block whose auto-expand status flips (a head entering/
 *  leaving its concealed region) is inside the span and rebuilt. */
function computeExtendedSpan(tr: Transaction): Interval[] {
  const state = tr.state;
  const raw: Interval[] = [];
  if (tr.docChanged) {
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) =>
      raw.push(lineExpandWithNeighbours(state, fromB, toB))
    );
  }
  for (const r of tr.startState.selection.ranges) {
    const a = tr.changes.mapPos(r.from, 1);
    const b = tr.changes.mapPos(r.to, -1);
    raw.push(lineExpandWithNeighbours(state, Math.min(a, b), Math.max(a, b)));
  }
  for (const r of tr.state.selection.ranges) {
    raw.push(lineExpandWithNeighbours(state, r.from, r.to));
  }
  return mergeIntervals(raw);
}

// The fenced policy, unchanged: GF structural edit or a top-level boundary move → full;
// an incomplete parse → full (G2 frontier); otherwise changed lines ±1 ∪ selection lines.
//
// The frontier gate (an incomplete parse can reveal nodes outside the span) is spelled out
// here, and the structural-reparse fallback is deliberately NOT part of this condition, the
// way it is in the fields that import ../structural-guard.js: `touchesStructural` /
// `topLevelBoundaryRisk` above already return "full" before the gate is reached. That guard
// is narrower than the shared predicate on purpose — this field's hot path is editing INSIDE
// a code fence, where a `#` comment or a `___` line must stay bounded; ../structural-guard.ts's
// header owns that rationale.
const fencedCollapseSpec: LineCollapseSpec<null> = {
  ...fencedCollapseTarget,
  makeWidget: ({ key, expanded, hiddenCount }) =>
    new FencedCollapseToggleWidget(key, expanded, hiddenCount),
  docChangePlan: (tr, prevBlocks) =>
    touchesStructural(tr) ||
    topLevelBoundaryRisk(tr, prevBlocks) ||
    !syntaxTreeAvailable(tr.state, tr.state.doc.length)
      ? "full"
      : computeExtendedSpan(tr),
};

export const fencedCodeCollapseField = defineLineCollapseField(fencedCollapseSpec, "bounded");
// Test-only oracle — identical reducer, always full-recompute on docChanged, NO
// `provide` (never wired into editor.ts). Used by cm-fenced-collapse-bounded.test.ts
// as the bounded≡full oracle; it carries the same sticky expanded state.
export const fencedCodeCollapseFieldFullRecompute = defineLineCollapseField(
  fencedCollapseSpec,
  "full"
);
