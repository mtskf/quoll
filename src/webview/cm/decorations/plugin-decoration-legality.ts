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
// The two rules are @codemirror/view's own (dist/index.js:2733-2738): for a
// PointDecoration from a dynamic (plugin) source,
//   - `deco.block` is forbidden outright, and
//   - a replace may not end past the end of the line its start sits on.
//
// ⚠️ This judges every decoration INDIVIDUALLY, which is deliberately STRICTER
// than CodeMirror in one corner: an illegal point that another, higher-
// precedence point COVERS never reaches CodeMirror's check at all, so CM
// tolerates it. Probed: a block widget at 14 under a `replace(13, 16)` does not
// throw, while the same widget uncovered does. Do NOT relax this to match.
// Coverage is an artifact of walk geometry — CM's emit runs per changed REGION,
// so whether coverage saves a widget can differ between builds of the SAME set,
// and a per-provider check cannot see coverage coming from other decoration
// sources regardless. Erring strict costs a provider that was already emitting
// an illegal shape one contained skip; erring lenient lets the escape through
// on the build where the covering decoration happens not to be there.

import type { Text } from "@codemirror/state";
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
 *  `iter()` is layer-complete and is what makes this correct: it walks EVERY
 *  layer (`HeapCursor` defaults to `minPoint: -1`, so no layer is filtered out)
 *  and yields ranges by ascending `from` across layers. The rejected `maxPoint`
 *  gate above is what was layer-blind, not the cursor.
 *
 *  `RangeSet.spans(…, minPointSize: 0)` is the other correct option — it yields
 *  only points and clips to the query window for free — and it was measured
 *  head-to-head against this walk on real provider output (400-line document, 10
 *  providers, 2080 ranges, 1839 points). It lost: a spans guard cost ~76 µs per
 *  build, and spans with an EMPTY callback still cost ~42 µs, where this entire
 *  walk costs ~33 µs. Since this runs on every keystroke the cheaper walk wins,
 *  and the two things spans gave for free are reproduced explicitly below.
 *  Numbers + method: .claude/docs/PERF-log.md.
 */
export function findPluginIllegalDecoration(built: DecorationSet, doc: Text): string | null {
  // Reproduces the clipping `RangeSet.spans` would have applied. CodeMirror's
  // own check runs inside a spans walk bounded by the document, so a decoration
  // running past the end is judged on its clipped EXTENT — flagging it whole
  // would reject a provider CodeMirror was perfectly happy with. A point
  // sitting exactly AT `doc.length` is still visited (spans visits it too),
  // which is what keeps a block widget at the very end catchable. Note this is
  // about extent only; it is NOT a general licence to match CM's tolerances —
  // see the covered-point note in the module header for the one we decline.
  const docEnd = doc.length;
  // Cached bounds of the line the last sized point started on. The cursor yields
  // ranges by ascending `from`, and providers emit several concealed markers per
  // line (both `**` of a bold span, a link's brackets and its target), so this
  // turns one O(log n) doc.lineAt per sized point into roughly one per line —
  // measured at ~4.6 points per line on a realistic document, and those lineAt
  // calls were the walk's dominant cost before the cache existed. The empty
  // range (-1, -2) can never satisfy the containment test below, so the first
  // sized point refreshes it.
  let lineFrom = -1;
  let lineTo = -2;
  const cursor = built.iter();
  while (cursor.value !== null) {
    const deco = cursor.value;
    // Marks are not points and can trip neither rule, so they cost one boolean.
    if (deco.point && cursor.from <= docEnd) {
      // `block` is PointDecoration's own field — MarkDecoration and
      // LineDecoration do not have it, so this identifies the class CodeMirror
      // checks without an instanceof against a non-exported constructor. NOT
      // `deco.spec.block`: specs carry arbitrary extra properties, and a stray
      // `block: true` on a mark or line spec must not condemn a legal provider.
      if ((deco as unknown as { block?: unknown }).block === true) {
        return `a block decoration at ${cursor.from}..${cursor.to}`;
      }
      // Zero-length points (inline widgets, line decorations) can never reach
      // past their own line, so only sized points pay for the lineAt lookup.
      const to = cursor.to < docEnd ? cursor.to : docEnd;
      if (to > cursor.from) {
        if (cursor.from < lineFrom || cursor.from > lineTo) {
          const line = doc.lineAt(cursor.from);
          lineFrom = line.from;
          lineTo = line.to;
        }
        if (to > lineTo) {
          return `a decoration replacing a line break at ${cursor.from}..${cursor.to}`;
        }
      }
    }
    cursor.next();
  }
  return null;
}
