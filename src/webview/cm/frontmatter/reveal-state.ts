// The C8b reveal state machine for the leading-frontmatter block. C8a held a
// bare `FrontmatterSpan | null` and always rendered a read-only block; C8b
// makes the block click/caret-to-edit via a 3-state machine. All view
// artefacts (widget decoration, atomicRanges, read-only transactionFilter, the
// de-markdown exclusion-facet contribution) derive from this state in
// frontmatter-field.ts.
//
// Why STATEFUL (not selection-derived like table/image): on open the caret may
// sit at offset 0 (the span boundary), but the block must stay COLLAPSED
// (block-on-open). A pure selection-overlap reveal would open it. Reveal is an
// explicit gesture (click / ArrowUp-into); a NEW detected span starts collapsed.
//
// Why a SINGLE dispatch (no pendingReveal): CodeMirror's atomicRanges install
// no transactionFilter (verified against @codemirror/view source), so a
// programmatic `view.dispatch({ effects, selection })` lands the caret inside
// the (still-collapsed-in-startState) span without being pushed out. The field
// update sees both the effect and the new selection and goes collapsed→revealed
// directly.
//
// Why a dedicated reseed annotation (not addToHistory=false): `addToHistory:
// false` is a generic history flag, not specific to host reseeds. Only
// applyDocument is a host snapshot reseed, so it marks its transaction with
// `hostDocumentReseed`; the changeFilter and this reducer key on THAT, never
// on addToHistory.
//
// Why provenance via ChangeSet coverage (not a boolean / mapped range): a
// select-all+paste maps the old span into the pasted text, so a mapped range
// would wrongly inherit the reveal. We instead check whether ANY single changed
// range (OLD coords) covers the old span; if so, provenance broke and the new
// span starts collapsed. Checked per-range, NOT as a union envelope — two
// disjoint edits bracketing the span would otherwise falsely report coverage
// and collapse an active reveal. (`ChangeDesc.touchesRange === "cover"` can NOT
// be used: it needs `pos < from` strictly, impossible for a from=0 leading
// span.)

import {
  Annotation,
  type ChangeDesc,
  type EditorState,
  StateEffect,
  type Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { intersectsAnySelection } from "../decorations/shared.js";
import { detectLeadingFrontmatterInState, type FrontmatterSpan } from "./detect.js";

export type RevealState =
  | { kind: "absent" }
  | { kind: "collapsed"; span: FrontmatterSpan }
  | { kind: "revealed"; span: FrontmatterSpan };

/** Marks a host-snapshot reseed transaction (set by editor.ts applyDocument).
 *  The frontmatter transactionFilter + this reducer key on it to distinguish a
 *  reseed from user edits and from other addToHistory=false transactions. */
export const hostDocumentReseed = Annotation.define<boolean>();

/** Dispatched (with a selection inside the span, same transaction) by the click
 *  handler and the ArrowUp keymap to reveal the block. */
export const revealFrontmatterEffect = StateEffect.define<null>();

/** A NEW detected span always starts COLLAPSED — block-on-open, no seed hack. */
export function initialRevealState(state: EditorState): RevealState {
  const span = detectLeadingFrontmatterInState(state);
  return span ? { kind: "collapsed", span } : { kind: "absent" };
}

/** Does ANY single changed range (OLD coords) cover `range`? Checked
 *  per-range, NOT as a union envelope: two disjoint edits bracketing the span
 *  (one ending at/before from, one starting at/after to) must NOT count as
 *  coverage — neither one rewrites the span interior, so provenance survives. */
function changeCoversRange(changes: ChangeDesc, range: { from: number; to: number }): boolean {
  let covered = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= range.from && toA >= range.to) {
      covered = true;
    }
  });
  return covered;
}

/** CodeMirror's canonical "can edit" authority is EditorState.readOnly; the
 *  EditorView.editable facet controls the DOM contenteditable. The reveal logic
 *  checks BOTH so a (readOnly=true, editable=true) combination cannot leak a
 *  reveal (Codex re-review #4). */
function isWritable(state: EditorState): boolean {
  return !state.readOnly && state.facet(EditorView.editable);
}

export function nextRevealState(prev: RevealState, tr: Transaction): RevealState {
  const candidate = computeNextRevealState(prev, tr);
  // INVARIANT: `revealed` requires write access. Enforced as a post-branch
  // normalization (not a single branch) so NO branch ordering can leak a
  // revealed state without write access — a combined docChanged+revoke or
  // revealEffect+revoke transaction collapses regardless of which branch made
  // the candidate (Codex re-review #1). Also catches the canWrite-only reseed
  // (docChanged=false → skips branch 0; the reconfigure makes it non-writable).
  if (candidate.kind === "revealed" && !isWritable(tr.state)) {
    return { kind: "collapsed", span: candidate.span };
  }
  return candidate;
}

function computeNextRevealState(prev: RevealState, tr: Transaction): RevealState {
  const isReseed = tr.annotation(hostDocumentReseed) === true;

  // (0) Host reseed with a doc change: re-detect, preserve reveal iff the
  // restored caret is in the span (writability enforced by the normalization).
  if (isReseed && tr.docChanged) {
    const newSpan = detectLeadingFrontmatterInState(tr.state);
    if (newSpan === null) {
      return { kind: "absent" };
    }
    return prev.kind === "revealed" &&
      intersectsAnySelection(tr.state.selection, newSpan.from, newSpan.to)
      ? { kind: "revealed", span: newSpan }
      : { kind: "collapsed", span: newSpan };
  }

  // (1) User doc change: re-detect + carry vs break.
  if (tr.docChanged) {
    const newSpan = detectLeadingFrontmatterInState(tr.state);
    const carry =
      prev.kind === "revealed" &&
      newSpan !== null &&
      !changeCoversRange(tr.changes, prev.span) &&
      intersectsAnySelection(tr.state.selection, newSpan.from, newSpan.to);
    if (carry && newSpan !== null) {
      return { kind: "revealed", span: newSpan };
    }
    return newSpan ? { kind: "collapsed", span: newSpan } : { kind: "absent" };
  }

  // (2) Reveal gesture (effect + same-tx selection): reveal iff the selection
  // lands in the span.
  if (tr.effects.some((e) => e.is(revealFrontmatterEffect))) {
    const span = detectLeadingFrontmatterInState(tr.state);
    if (span === null) {
      return prev;
    }
    return intersectsAnySelection(tr.state.selection, span.from, span.to)
      ? { kind: "revealed", span }
      : prev;
  }

  // (3) Selection change → re-collapse when the caret leaves the span.
  if (prev.kind === "revealed" && !tr.startState.selection.eq(tr.state.selection)) {
    return intersectsAnySelection(tr.state.selection, prev.span.from, prev.span.to)
      ? prev
      : { kind: "collapsed", span: prev.span };
  }

  return prev;
}

/** Reveal the leading frontmatter for editing and land the caret at `anchor`
 *  (clamped to the span; intersectsAnySelection is closed-interval so anchor ===
 *  span.to still reveals), in ONE dispatch. No-op (false) when there is no span
 *  or the editor is not writable (readOnly OR not editable). */
export function revealFrontmatterAt(view: EditorView, anchor: number): boolean {
  const span = detectLeadingFrontmatterInState(view.state);
  if (span === null) {
    return false;
  }
  if (!isWritable(view.state)) {
    return false;
  }
  const clamped = Math.max(span.from, Math.min(anchor, span.to));
  view.dispatch({
    effects: revealFrontmatterEffect.of(null),
    selection: { anchor: clamped },
    scrollIntoView: true,
  });
  return true;
}
