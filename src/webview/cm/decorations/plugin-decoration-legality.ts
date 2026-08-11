// CodeMirror refuses two kinds of decoration from a ViewPlugin, and refuses
// them LATE — inside TileUpdate.emit's own RangeSet.spans walk, reached from
// DocView.update → updateInner once findChangedDeco has decided which ranges
// to re-emit. (NOT via RangeSet.compare: that is the path the poisoned-
// accumulator case takes, and copying its route here would misdescribe this
// one.) That call site is NOT inside PluginInstance.update's try, so the throw
// does not even reach the permanent deactivate() that a build() throw would:
// it escapes view.dispatch() into Quoll's own caller and aborts the update
// mid-flight, logging nothing. This module answers the question CodeMirror will
// ask later, early enough for the orchestrator to contain the answer to the one
// provider responsible.
//
// The two rules mirror @codemirror/view's own check verbatim (dist/index.js
// :2733-2738): for a PointDecoration from a dynamic (plugin) source,
//   - `deco.block` is forbidden outright, and
//   - a replace may not end past the end of the line its start sits on.

import { RangeSet, type Text } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

/** Inspect `built` for a decoration a ViewPlugin may not emit.
 *
 *  Returns `null` when the set is legal, otherwise a short reason naming the
 *  offending range — the caller turns that into the thrown error's message.
 *  Reports the FIRST offender in document order: the provider is rejected
 *  wholesale either way, so enumerating the rest would only cost time on an
 *  already-failing build.
 *
 *  ⚠️ The obvious cheap gate — an O(1) `built.maxPoint` check for "holds no
 *  point decoration at all" — is WRONG, twice. `maxPoint` is not on RangeSet's
 *  public type (it is RangeSetBuilder's private field), and the value a set
 *  does carry internally summarises only its TOP layer: RangeSetBuilder.add
 *  spills any range overlapping the previous one into a nextLayer whose
 *  maxPoint finishInner never folds in. A block widget overlapping a mark —
 *  the realistic provider bug — therefore sits in a set whose top-level
 *  maxPoint is -1, and such a gate would wave it through while CodeMirror still
 *  throws. Do not reintroduce it.
 *
 *  `RangeSet.spans` with `minPointSize: 0` is the public API that gets this
 *  right AND is cheaper than a raw `iter()` walk:
 *   - it admits layers by their OWN maxPoint, which is accurate per layer, so
 *     point-free layers are skipped wholesale and spilled points are still
 *     visited;
 *   - the cursor yields only point values, so marks never reach the callback;
 *   - zero-length points are included, which is what catches block widgets;
 *   - it clips to the [0, doc.length] query window, so ranges running past the
 *     end of the document are seen exactly as CodeMirror's own emit() sees them
 *     rather than over-rejected — and `from` is a valid document position by
 *     construction, so `doc.lineAt` below can never be handed one out of range.
 */
export function findPluginIllegalDecoration(built: DecorationSet, doc: Text): string | null {
  let found: string | null = null;
  RangeSet.spans(
    [built],
    0,
    doc.length,
    {
      span: () => {},
      point: (from, to, value) => {
        // RangeSet.spans has no early exit, so the walk runs to completion once
        // an offender is found. Guarding here keeps "first offender in document
        // order" true and reduces the rest of the walk to a null check.
        if (found !== null) {
          return;
        }
        // `block` is PointDecoration's own field — MarkDecoration and
        // LineDecoration do not have it, so this identifies the class
        // CodeMirror checks without an instanceof against a non-exported
        // constructor. NOT `deco.spec.block`: specs carry arbitrary extra
        // properties, and a stray `block: true` on a mark or line spec must not
        // condemn a legal provider.
        if ((value as { block?: unknown }).block === true) {
          found = `a block decoration at ${from}..${to}`;
          return;
        }
        // Zero-length points (inline widgets, line decorations) can never reach
        // past their own line, so only sized points pay for the lineAt lookup.
        if (to > from && to > doc.lineAt(from).to) {
          found = `a decoration replacing a line break at ${from}..${to}`;
        }
      },
    },
    0
  );
  return found;
}
