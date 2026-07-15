// Selection-INDEPENDENT ViewPlugin emitting one language-picker widget per
// fenced code block whose open line is visible — top-level AND blockquote-/
// list-nested, exactly like the copy button (fenced-code-copy-button.ts), whose
// build/rebuild structure this mirrors. Read-only surfaces get nothing (the
// picker is interactive); a non-plain info string (attr-list) is skipped
// (fenceLanguageTarget returns null). An INLINE point widget is legal from a
// ViewPlugin; only BLOCK replaces are not. The widget's change routes through
// setFenceLanguage (guarded dispatch).

import { syntaxTree } from "@codemirror/language";
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
import { buildVisibleFencedCodeWidgets } from "./fenced-code-open-widgets.js";

export function buildLanguagePickers(ctx: BuildContext): DecorationSet {
  if (ctx.state.readOnly) {
    return Decoration.none;
  }
  // The visible-range walk + open-line anchor + de-dup + ordering live in the
  // shared enumerator; here we only build the picker for each block whose info
  // string is plain.
  return buildVisibleFencedCodeWidgets(ctx, (node, openFrom) => {
    const target = fenceLanguageTarget(ctx.state, node);
    if (target === null) {
      // Non-plain info string (attr-list) — no picker (cannot rewrite safely).
      return null;
    }
    return new LanguagePickerWidget(openFrom, target.language);
  });
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
