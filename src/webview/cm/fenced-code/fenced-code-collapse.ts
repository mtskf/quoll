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

import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import {
  type Interval,
  intersects,
  lineExpandWithNeighbours,
  mergeIntervals,
} from "../bounded-recompute.js";
import { hostDocumentReseed } from "../frontmatter/reveal-state.js";
import { fencedBlockGeometry, setFencedCollapseEffect } from "./fenced-code-collapse-state.js";
import { FencedCollapseToggleWidget } from "./fenced-code-collapse-widget.js";

interface FencedBlockRecord {
  key: number;
  blockFrom: number;
  blockTo: number;
  expanded: boolean;
  hiddenCount: number;
  decoFrom: number;
  decoTo: number;
  deco: Decoration;
}

interface CollapseState {
  /** Keys (open-fence offsets) of explicitly- or auto-expanded blocks. */
  expanded: ReadonlySet<number>;
  /** Document-ordered reuse records — one per collapsible block. */
  blocks: FencedBlockRecord[];
  decorations: DecorationSet;
}

/** DD4: any selection range whose HEAD sits in the closed interval [from, to].
 *  Checks every range (multi-cursor), not just main — a secondary caret in a
 *  concealed region must auto-expand. A select-all's single range has its head at
 *  doc end, so mid-document blocks are NOT expanded. */
function anyHeadInside(selection: EditorSelection, from: number, to: number): boolean {
  for (const r of selection.ranges) {
    if (r.head >= from && r.head <= to) {
      return true;
    }
  }
  return false;
}

/** Build the record for one collapsible block. Collapsed → a block replace over
 *  [concealFrom, collapseTo]; expanded → a side:1 point widget at concealTo. `blockTo`
 *  is the LIVENESS extent (closed → collapseTo; unclosed → docLength), distinct from
 *  the decoration range. */
function recordFor(
  g: { key: number; concealFrom: number; concealTo: number; collapseTo: number; closed: boolean },
  isExpanded: boolean,
  hiddenCount: number,
  docLength: number
): FencedBlockRecord {
  const blockTo = g.closed ? g.collapseTo : docLength;
  if (isExpanded) {
    return {
      key: g.key,
      blockFrom: g.key,
      blockTo,
      expanded: true,
      hiddenCount,
      decoFrom: g.concealTo,
      decoTo: g.concealTo,
      deco: Decoration.widget({
        widget: new FencedCollapseToggleWidget(g.key, true, hiddenCount),
        block: true,
        side: 1,
      }),
    };
  }
  return {
    key: g.key,
    blockFrom: g.key,
    blockTo,
    expanded: false,
    hiddenCount,
    decoFrom: g.concealFrom,
    decoTo: g.collapseTo,
    deco: Decoration.replace({
      widget: new FencedCollapseToggleWidget(g.key, false, hiddenCount),
      block: true,
    }),
  };
}

/** Walk every TOP-LEVEL collapsible FencedCode whose FULL extent overlaps
 *  [rangeFrom, rangeTo] and emit its record. Expanded iff key ∈ `expanded` OR a
 *  selection head sits inside its concealed region (auto-expand, DD4). */
function buildFencedRange(
  state: EditorState,
  expanded: ReadonlySet<number>,
  rangeFrom: number,
  rangeTo: number
): FencedBlockRecord[] {
  const out: FencedBlockRecord[] = [];
  const docLength = state.doc.length;
  syntaxTree(state).iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      if (node.name === "FencedCode") {
        const g = fencedBlockGeometry(state, node.node);
        if (g !== null) {
          const isExpanded =
            expanded.has(g.key) || anyHeadInside(state.selection, g.concealFrom, g.collapseTo);
          const hiddenCount =
            state.doc.lineAt(g.concealTo).number - state.doc.lineAt(g.concealFrom).number + 1;
          out.push(recordFor(g, isExpanded, hiddenCount, docLength));
        }
        return false; // never descend into a code body
      }
      // Descend only through the Document root; skip every other subtree.
      return node.name === "Document" ? undefined : false;
    },
  });
  return out;
}

/** Assemble the field state from a record list (dedupes + orders by blockFrom). */
function assemble(blocks: FencedBlockRecord[]): CollapseState {
  const sorted = [...blocks].sort((a, b) => a.blockFrom - b.blockFrom);
  const liveExpanded = new Set<number>();
  for (const b of sorted) {
    if (b.expanded) {
      liveExpanded.add(b.key);
    }
  }
  const decorations = Decoration.set(
    sorted.map((b) => b.deco.range(b.decoFrom, b.decoTo)),
    true
  );
  return { expanded: liveExpanded, blocks: sorted, decorations };
}

function buildFullState(state: EditorState, expanded: ReadonlySet<number>): CollapseState {
  return assemble(buildFencedRange(state, expanded, 0, state.doc.length));
}

/** Public helper kept for the existing unit tests — a thin projection of the full
 *  state (decorations + a fresh copy of the reconciled live expanded-key set). */
export function buildFencedCollapse(
  state: EditorState,
  expanded: ReadonlySet<number>
): { decorations: DecorationSet; liveExpanded: Set<number> } {
  const s = buildFullState(state, expanded);
  return { decorations: s.decorations, liveExpanded: new Set(s.expanded) };
}

/** DD2 fast-path: does any selection head sit inside a CURRENTLY-collapsed region
 *  (a block-replace range, from < to) of `prev`? The only selection-driven
 *  decoration change is auto-EXPAND (expanded blocks are sticky and never
 *  re-collapse on caret-leave), so a selection-only transaction needs a rebuild
 *  ONLY when a head newly enters a collapsed region. */
function selectionEntersCollapsed(prev: DecorationSet, selection: EditorSelection): boolean {
  const iter = prev.iter();
  while (iter.value !== null) {
    if (iter.from < iter.to && anyHeadInside(selection, iter.from, iter.to)) {
      return true;
    }
    iter.next();
  }
  return false;
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
function topLevelBoundaryRisk(tr: Transaction, prevBlocks: readonly FencedBlockRecord[]): boolean {
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
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => raw.push(lineExpandWithNeighbours(state, fromB, toB)));
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

/** Reconstruct a reused record at shifted positions (bytes unchanged → geometry shifts
 *  rigidly; only the widget key needs remapping so the toggle command still resolves
 *  the block). Returns `b` VERBATIM when nothing shifted — the reference-identity the
 *  non-vacuity test asserts. */
function shiftRecord(b: FencedBlockRecord, tr: Transaction): FencedBlockRecord {
  const key = tr.changes.mapPos(b.key, 1);
  const blockFrom = tr.changes.mapPos(b.blockFrom, 1);
  const blockTo = tr.changes.mapPos(b.blockTo, -1);
  const decoFrom = tr.changes.mapPos(b.decoFrom, 1);
  const decoTo = b.expanded ? decoFrom : tr.changes.mapPos(b.decoTo, -1);
  if (
    key === b.key &&
    blockFrom === b.blockFrom &&
    blockTo === b.blockTo &&
    decoFrom === b.decoFrom &&
    decoTo === b.decoTo
  ) {
    return b;
  }
  const widget = new FencedCollapseToggleWidget(key, b.expanded, b.hiddenCount);
  const deco = b.expanded
    ? Decoration.widget({ widget, block: true, side: 1 })
    : Decoration.replace({ widget, block: true });
  return {
    key,
    blockFrom,
    blockTo,
    expanded: b.expanded,
    hiddenCount: b.hiddenCount,
    decoFrom,
    decoTo,
    deco,
  };
}

/** Reuse prev records whose FULL extent [blockFrom, blockTo] is untouched AND outside
 *  the span; re-walk the tree only inside the span. Full-extent liveness — NOT the
 *  decoration range, which covers only the concealed tail. */
function computeBounded(
  prevBlocks: readonly FencedBlockRecord[],
  tr: Transaction,
  intervals: Interval[],
  working: ReadonlySet<number>
): CollapseState {
  const byFrom = new Map<number, FencedBlockRecord>();
  for (const b of prevBlocks) {
    const touched = tr.changes.touchesRange(b.blockFrom, b.blockTo) !== false;
    const newFrom = tr.changes.mapPos(b.blockFrom, 1);
    const newTo = tr.changes.mapPos(b.blockTo, -1);
    if (!touched && !intersects(intervals, newFrom, newTo)) {
      const r = shiftRecord(b, tr);
      byFrom.set(r.blockFrom, r);
    }
  }
  for (const iv of intervals) {
    for (const r of buildFencedRange(tr.state, working, iv.from, iv.to)) {
      byFrom.set(r.blockFrom, r); // fresh wins (a block spanning two intervals de-dupes)
    }
  }
  return assemble([...byFrom.values()]);
}

type BuildMode = "bounded" | "full";

/** One reducer, two configs. `bounded` (production) takes the changed-range path on a
 *  plain docChanged; `full` (test-only oracle) always full-recomputes there. Both share
 *  every other branch (reseed / effect / GF / background-parse / selection), so the full
 *  variant threads the SAME sticky `expanded` state — which a fresh EditorState.create
 *  cannot model — making bounded≡full a true replay equivalence. The oracle omits
 *  `provide` so two block-decoration fields never collide in one view. */
function defineField(mode: BuildMode): StateField<CollapseState> {
  return StateField.define<CollapseState>({
    create: (state) => buildFullState(state, new Set()),
    update: (prev, tr) => {
      // 1. DD3 host-snapshot reseed → rebuild from EMPTY.
      if (tr.annotation(hostDocumentReseed) === true && tr.docChanged) {
        return buildFullState(tr.state, new Set());
      }
      // 2. Map expanded keys through the change; apply toggle effects (DD5).
      let working: ReadonlySet<number> = prev.expanded;
      if (tr.docChanged) {
        const mapped = new Set<number>();
        for (const k of prev.expanded) {
          mapped.add(tr.changes.mapPos(k, 1));
        }
        working = mapped;
      }
      let effectTouched = false;
      for (const e of tr.effects) {
        if (e.is(setFencedCollapseEffect)) {
          effectTouched = true;
          const next = new Set(working);
          if (e.value.expanded) {
            next.add(e.value.key);
          } else {
            next.delete(e.value.key);
          }
          working = next;
        }
      }
      // 3. Effect toggle (rare user gesture — a toggled block can be anywhere) → full.
      //    GF structural edit (fence-delimiter / container-marker / HTML-tag on a changed
      //    line) OR a top-level blank-line boundary move (HTML-block termination) → full.
      if (
        effectTouched ||
        (tr.docChanged && (touchesStructural(tr) || topLevelBoundaryRisk(tr, prev.blocks)))
      ) {
        return buildFullState(tr.state, working);
      }
      // 4. Hot path: a plain docChanged rebuilds changed-range-bounded, with the G2
      //    frontier fallback (an incomplete parse can reveal nodes outside the span).
      if (tr.docChanged) {
        if (mode === "full" || !syntaxTreeAvailable(tr.state, tr.state.doc.length)) {
          return buildFullState(tr.state, working);
        }
        return computeBounded(prev.blocks, tr, computeExtendedSpan(tr), working);
      }
      // 5. Background-parse publication (tree identity changed, no doc change) → full
      //    to self-heal any node the earlier bounded walk could not see.
      if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return buildFullState(tr.state, working);
      }
      // 6. Selection-only: rebuild ONLY when a head enters a currently-collapsed region
      //    (auto-expand). Otherwise decorations are unchanged — return `prev` verbatim.
      const selectionMoved = !tr.startState.selection.eq(tr.state.selection);
      if (selectionMoved && selectionEntersCollapsed(prev.decorations, tr.state.selection)) {
        return buildFullState(tr.state, working);
      }
      return prev;
    },
    ...(mode === "bounded"
      ? {
          provide: (f: StateField<CollapseState>) =>
            EditorView.decorations.from(f, (s) => s.decorations),
        }
      : {}),
  });
}

export const fencedCodeCollapseField = defineField("bounded");
// Test-only oracle — identical reducer, always full-recompute on docChanged, NO
// `provide` (never wired into editor.ts). Used by cm-fenced-collapse-bounded.test.ts
// as the bounded≡full oracle; it carries the same sticky expanded state.
export const fencedCodeCollapseFieldFullRecompute = defineField("full");
