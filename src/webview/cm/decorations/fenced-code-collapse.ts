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

import { syntaxTree } from "@codemirror/language";
import { type EditorSelection, type EditorState, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { hostDocumentReseed } from "../frontmatter/reveal-state.js";
import { fencedBlockGeometry, setFencedCollapseEffect } from "./fenced-code-collapse-state.js";
import { FencedCollapseToggleWidget } from "./fenced-code-collapse-widget.js";

interface CollapseState {
  /** Keys (open-fence offsets) of explicitly- or auto-expanded blocks. */
  expanded: ReadonlySet<number>;
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

/** Walk every TOP-LEVEL collapsible FencedCode and emit its decoration. A block is
 *  expanded iff its key is in `expanded` OR a selection head sits inside its
 *  concealed region (auto-expand, DD4). Returns the reconciled live expanded-key
 *  set (dead keys dropped; auto-expanded keys added so expansion is sticky). */
export function buildFencedCollapse(
  state: EditorState,
  expanded: ReadonlySet<number>
): { decorations: DecorationSet; liveExpanded: Set<number> } {
  const built: Array<{ from: number; to: number; deco: Decoration }> = [];
  const liveExpanded = new Set<number>();
  // DD2: top-level-only walk. Process each Document-child FencedCode and skip its
  // body; skip descending into every other node (a top-level fence is never nested
  // inside a Paragraph/List/Blockquote). O(top-level block count).
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "FencedCode") {
        const g = fencedBlockGeometry(state, node.node);
        if (g !== null) {
          const isExpanded =
            expanded.has(g.key) || anyHeadInside(state.selection, g.concealFrom, g.collapseTo);
          const hiddenCount =
            state.doc.lineAt(g.concealTo).number - state.doc.lineAt(g.concealFrom).number + 1;
          if (isExpanded) {
            liveExpanded.add(g.key);
            // Show-less bar: a block point widget after the last body line (side:1),
            // so it sits between the body and the closing-fence footer line.
            built.push({
              from: g.concealTo,
              to: g.concealTo,
              deco: Decoration.widget({
                widget: new FencedCollapseToggleWidget(g.key, true, hiddenCount),
                block: true,
                side: 1,
              }),
            });
          } else {
            // Show-more bar: a block replace over body lines 11..N PLUS the closing
            // fence (collapseTo), so the bar is the sole footer — a caret parked on the
            // ``` auto-expands (isExpanded above) rather than double-rounding the footer.
            built.push({
              from: g.concealFrom,
              to: g.collapseTo,
              deco: Decoration.replace({
                widget: new FencedCollapseToggleWidget(g.key, false, hiddenCount),
                block: true,
              }),
            });
          }
        }
        return false; // never descend into a code body
      }
      // Descend only through the Document root; skip every other subtree.
      return node.name === "Document" ? undefined : false;
    },
  });
  built.sort((a, b) => a.from - b.from || a.to - b.to);
  const decorations = Decoration.set(
    built.map((b) => b.deco.range(b.from, b.to)),
    true
  );
  return { decorations, liveExpanded };
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
  create: (state) => {
    const { decorations, liveExpanded } = buildFencedCollapse(state, new Set());
    return { expanded: liveExpanded, decorations };
  },
  update: (prev, tr) => {
    // DD3: a host-snapshot reseed (full 0..len replace) rebuilds from EMPTY —
    // mapping keys through a whole-document replace is meaningless and would let a
    // new doc's first fence inherit expansion. Matches native fold (external edits
    // clear folds); the restored caret then auto-expands its own block via build.
    if (tr.annotation(hostDocumentReseed) === true && tr.docChanged) {
      const { decorations, liveExpanded } = buildFencedCollapse(tr.state, new Set());
      return { expanded: liveExpanded, decorations };
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
      const { decorations, liveExpanded } = buildFencedCollapse(tr.state, working);
      return { expanded: liveExpanded, decorations };
    }
    // 4. DD2 fast-path: a selection-only transaction rebuilds ONLY when a head
    //    enters a collapsed region (→ auto-expand). Otherwise decorations are
    //    unchanged — return `prev` verbatim (no walk, no new DecorationSet).
    const selectionMoved = !tr.startState.selection.eq(tr.state.selection);
    if (selectionMoved && selectionEntersCollapsed(prev.decorations, tr.state.selection)) {
      const { decorations, liveExpanded } = buildFencedCollapse(tr.state, working);
      return { expanded: liveExpanded, decorations };
    }
    return prev;
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decorations),
});
