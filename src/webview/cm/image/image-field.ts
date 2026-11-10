// The image spec of the structural block contract (../structural-blocks.ts): every
// STANDALONE Markdown image (an inline `Image` node that is the sole content of its parent
// Paragraph and line) renders as a non-editable block widget. Range ownership, the
// changed-range-bounded update, the full-rebuild reasons, failure → raw source and
// line-level reveal all live in the contract module; this file says only which images are
// eligible, what their block carries and which widget shows it.
//
// Eligibility (explicit; CommonMark images are INLINE — they live inside a Paragraph):
//   1. inline form only: a `URL` child means `![alt](url)`. Reference images `![a][ref]`
//      and empty-destination `![a]()` have no URL child → skipped (left as raw source).
//   2. parent is a Paragraph whose entire trimmed content equals the image — excludes
//      inline images amid prose and soft-break siblings sharing the paragraph (promoting one
//      line of a multi-line paragraph would split it).
//   3. the image's line(s) trimmed equal the image — excludes blockquote `> ![…]` and list
//      `- ![…]`, whose paragraph text equals the image but whose LINE carries a prefix
//      marker that a whole-line block-replace would wrongly swallow.
//
// Render-gate (fail-closed): the Lezer `URL` child is decoded + allowlist-gated via the
// SHARED `renderSafeMarkdownDestination` (the one render-side decode→gate choke point, also
// used by the neutral inline tokenizer cm/inline/inline-ir.ts that the table-cell renderer
// drives, so the two render gates cannot drift). Passing a raw slice straight to the
// allowlist would fail open on angle-bracket / backslash / char-ref forms. Any throw in
// decode/gate is caught and treated as blocked (safeUrl = null): that is this spec's own
// fallback — a blocked-placeholder widget — not the contract's absent-record fallback. The
// verdict (AllowlistedUrl | null) is handed to the widget, which never re-gates.
//
// Alt is the CommonMark-normalized image label: the raw chars between `![` and the
// label-closing `]` are run through `commonMarkAltText` (backslash/entity decode + emphasis
// flatten) so `<img alt>` and the blocked placeholder's `aria-label` carry the rendered
// text, not the raw markup.
//
// The payload stores no document position (the block range lives in the record set), so a
// shifted block keeps the same payload object with no re-parse. Performance numbers: .claude/docs/PERF.md.

import type { EditorState } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import { renderSafeMarkdownDestination } from "../../../markdown/render-safe-markdown-destination.js";
import type { AllowlistedUrl } from "../../../markdown/url-allowlist.js";
import { commonMarkAltText } from "../inline/inline-ir.js";
import { type BuiltBlock, structuralBlockWidgets } from "../structural-blocks.js";
import { ImageBlockWidget } from "./image-widget.js";
import { quollResourceBaseUri, resolveAgainstBase } from "./resource-base.js";

export interface ImageBlock {
  readonly alt: string;
  readonly safeUrl: AllowlistedUrl | null;
  /** Trimmed image source: the widget's eq() key. */
  readonly imgText: string;
}

// Trim only ASCII *structural* whitespace: space, tab, LF, CR — the set the Lezer markdown
// parser treats as insignificant at a line/paragraph boundary (indentation + line endings).
// It deliberately EXCLUDES U+000B (vertical tab), U+000C (form feed), NBSP, and every other
// Unicode space, which the parser keeps as significant paragraph content (Codex probe: a
// leading VT stays inside the Paragraph node) — so a line whose only prefix is one of them
// must NOT be promoted to a standalone image, and a whole-line block-replace must not
// swallow it. `String.prototype.trim()` strips all of them and would mis-promote such lines
// (Codex re-review N1 + N4).
function trimAsciiWs(s: string): string {
  return s.replace(/^[ \t\n\r]+/, "").replace(/[ \t\n\r]+$/, "");
}

function buildImageBlock(state: EditorState, node: SyntaxNodeRef): BuiltBlock<ImageBlock> | null {
  // (1) inline form only.
  const urlNode = node.node.getChild("URL");
  if (!urlNode) {
    return null;
  }
  // (2) parent Paragraph contains ONLY the image.
  const parent = node.node.parent;
  if (!parent || parent.name !== "Paragraph") {
    return null;
  }
  const imgText = trimAsciiWs(state.sliceDoc(node.from, node.to));
  if (trimAsciiWs(state.sliceDoc(parent.from, parent.to)) !== imgText) {
    return null;
  }
  // (3) the image's line(s) carry no prefix marker beyond the image.
  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(Math.min(node.to, state.doc.length));
  if (trimAsciiWs(state.sliceDoc(startLine.from, endLine.to)) !== imgText) {
    return null;
  }
  // Render-gate, fail-closed. Shared decode→gate choke point with the table-cell renderer
  // (cm/table/cell-render.ts) so the two render gates cannot drift. Any decode/gate throw
  // also blocks rendering.
  let safeUrl: AllowlistedUrl | null;
  try {
    const safe = renderSafeMarkdownDestination(state.sliceDoc(urlNode.from, urlNode.to));
    safeUrl =
      safe.kind === "safe" ? resolveAgainstBase(safe.url, state.facet(quollResourceBaseUri)) : null;
  } catch {
    safeUrl = null;
  }
  // Alt = raw label source between `![` and the label-closing `]`. The `]` is the last `]`
  // before the `(` that opens the destination — robust to inner paren whitespace
  // `![a]( url )` and to a title `![a](url "t")`.
  const gap = state.sliceDoc(node.from + 2, urlNode.from);
  const parenIdx = gap.lastIndexOf("(");
  const bracketIdx = parenIdx >= 0 ? gap.lastIndexOf("]", parenIdx) : gap.lastIndexOf("]");
  const altRaw = bracketIdx >= 0 ? gap.slice(0, bracketIdx) : "";
  const alt = commonMarkAltText(altRaw);
  return { from: startLine.from, to: endLine.to, block: { alt, safeUrl, imgText } };
}

export const imageBlockField = structuralBlockWidgets<ImageBlock>({
  name: "image",
  node: "Image",
  build: buildImageBlock,
  widget: (b, from) => new ImageBlockWidget(b.alt, b.safeUrl, b.imgText, from),
});
