// Selection-INDEPENDENT ViewPlugin emitting one language-picker widget per
// fenced code block whose open line is visible — top-level AND blockquote-/
// list-nested, exactly like the copy button (fenced-code-copy-button.ts), whose
// build/rebuild structure this mirrors. Read-only surfaces get nothing (the
// picker is interactive); a non-plain info string (attr-list) is skipped
// (fenceLanguageTarget returns null). An INLINE point widget is legal from a
// ViewPlugin; only BLOCK replaces are not. The widget's change routes through
// setFenceLanguage (guarded dispatch).

import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { toCtx } from "../decorations/build-context.js";
import type { BuildContext } from "../decorations/types.js";
import { fenceLanguageTarget } from "./fenced-code-language.js";
import { LanguagePickerWidget } from "./fenced-code-language-picker-widget.js";

export function buildLanguagePickers(ctx: BuildContext): DecorationSet {
  if (ctx.state.readOnly) {
    return Decoration.none;
  }
  const doc = ctx.state.doc;
  const seen = new Set<number>();
  const out: Array<{ from: number; deco: Decoration }> = [];
  for (const range of ctx.visibleRanges) {
    ctx.tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (node.name !== "FencedCode") {
          return;
        }
        // Anchor at the open LINE start (not node.from — that sits after any
        // indent / `> `/list prefix). Same anchor + de-dup contract as the copy
        // button: do NOT gate on `openFrom >= range.from` (visibleRanges can begin
        // mid-line); the `seen` set collapses a block visited from multiple ranges
        // to one widget and the final sort satisfies RangeSetBuilder's
        // non-decreasing-from contract.
        const openFrom = doc.lineAt(node.from).from;
        if (seen.has(openFrom)) {
          return;
        }
        seen.add(openFrom);
        const target = fenceLanguageTarget(ctx.state, node.node);
        if (target === null) {
          // Non-plain info string (attr-list) — no picker (cannot rewrite safely).
          return;
        }
        const widget = new LanguagePickerWidget(openFrom, target.language);
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

export const fencedCodeLanguagePicker = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildLanguagePickers(toCtx(view));
    }
    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.startState.readOnly !== u.state.readOnly
      ) {
        this.decorations = buildLanguagePickers(toCtx(u.view));
      }
    }
  },
  { decorations: (v) => v.decorations }
);
