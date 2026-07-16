// Shared enumerator for the selection-INDEPENDENT fenced-code control widgets
// (the copy button in fenced-code-copy-button.ts and the language picker in
// fenced-code-language-picker.ts). Both walk fenced code blocks whose OPEN line
// is visible — top-level AND blockquote-/list-nested — anchored at the open-line
// start, de-duped per block, and ordered for RangeSetBuilder; each control then
// supplies its own per-block widget via `makeWidget` (which may return `null` to
// skip a block — the language picker does this for non-plain info strings, so it
// emits at most one widget per block, not exactly one). That walk (visible-range
// FencedCode iterate + open-line anchor + `seen` de-dup + sort) is identical
// across both controls, so it lives here once.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, type WidgetType } from "@codemirror/view";
import type { BuildContext } from "../decorations/types.js";
import {
  asFencedCodeNode,
  type FencedCodeNode,
  type OpenLineOffset,
  openLineOffsetOf,
} from "./fenced-code-node.js";

/** Emit one `side: -1` point widget per fenced code block whose OPEN line is in a
 *  visible range, anchored at that open-line start, invoking `makeWidget(node,
 *  openFrom)` for each unique block. Both arguments are BRANDED — `makeWidget`
 *  receives the {@link FencedCodeNode} the enumerator already proved and the
 *  {@link OpenLineOffset} it anchored at, so a caller can't mis-anchor a widget on
 *  a raw `node.from`. Returning `null` from `makeWidget` skips the block (the
 *  language picker suppresses non-plain info strings this way). Callers keep their
 *  own read-only / interactivity gate; this is a pure enumerator.
 *
 *  Anchor at the open LINE start (not `node.from`, which sits after any indent or
 *  `> `/list prefix): the fence-reveal HIDE replace begins at `node.from`, so a
 *  side:-1 point widget at the open-line start renders strictly before (indented /
 *  nested fence) or co-located with (unindented fence, associating BEFORE the
 *  replaced text) that replace.
 *
 *  De-dup by open-line offset only — do NOT gate on `openFrom >= range.from`.
 *  CodeMirror's visibleRanges can begin mid-line when a line-gap decoration splits
 *  a long wrapped line, so a fence whose open line starts just before the range
 *  would be silently dropped even though it is rendered (same reason list-hang-
 *  indent removed this guard — Codex review #92). The `seen` set collapses a block
 *  visited from multiple ranges to one widget; the final sort satisfies
 *  RangeSetBuilder's non-decreasing-`from` contract. */
export function buildVisibleFencedCodeWidgets(
  ctx: BuildContext,
  makeWidget: (node: FencedCodeNode, openFrom: OpenLineOffset) => WidgetType | null
): DecorationSet {
  const doc = ctx.state.doc;
  const seen = new Set<OpenLineOffset>();
  const out: Array<{ from: number; deco: Decoration }> = [];
  for (const range of ctx.visibleRanges) {
    ctx.tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const fenced = asFencedCodeNode(node);
        if (fenced === null) {
          return;
        }
        const openFrom = openLineOffsetOf(doc, fenced);
        if (seen.has(openFrom)) {
          return;
        }
        seen.add(openFrom);
        const widget = makeWidget(fenced, openFrom);
        if (widget === null) {
          return;
        }
        out.push({ from: openFrom, deco: Decoration.widget({ widget, side: -1 }) });
      },
    });
  }
  out.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of out) {
    builder.add(entry.from, entry.from, entry.deco);
  }
  return builder.finish();
}
