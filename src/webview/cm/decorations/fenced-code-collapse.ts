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

export const fencedCodeCollapseField = StateField.define<CollapseState>({
  create: (state) => buildFullState(state, new Set()),
  update: (prev, tr) => {
    // DD3: a host-snapshot reseed (full 0..len replace) rebuilds from EMPTY —
    // mapping keys through a whole-document replace is meaningless and would let a
    // new doc's first fence inherit expansion. Matches native fold (external edits
    // clear folds); the restored caret then auto-expands its own block via build.
    if (tr.annotation(hostDocumentReseed) === true && tr.docChanged) {
      return buildFullState(tr.state, new Set());
    }
    // 1. Map expanded keys through any document change. DD5: mapPos(key, 1) is the
    //    best-effort identity carry — an insert at EXACTLY a fence's line.from
    //    shifts the key off the new line.from and that block re-collapses (rare,
    //    lossless, pinned by a test). The build re-reconciles liveExpanded against
    //    real blocks afterwards, so a drifted key simply drops.
    let working: ReadonlySet<number> = prev.expanded;
    if (tr.docChanged) {
      const mapped = new Set<number>();
      for (const k of prev.expanded) {
        mapped.add(tr.changes.mapPos(k, 1));
      }
      working = mapped;
    }
    // 2. Apply toggle effects.
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
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    // 3. Doc / effect / async-parse changes always rebuild.
    if (tr.docChanged || effectTouched || treeChanged) {
      return buildFullState(tr.state, working);
    }
    // 4. DD2 fast-path: a selection-only transaction rebuilds ONLY when a head
    //    enters a collapsed region (→ auto-expand). Otherwise decorations are
    //    unchanged — return `prev` verbatim (no walk, no new DecorationSet).
    const selectionMoved = !tr.startState.selection.eq(tr.state.selection);
    if (selectionMoved && selectionEntersCollapsed(prev.decorations, tr.state.selection)) {
      return buildFullState(tr.state, working);
    }
    return prev;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decorations),
});
