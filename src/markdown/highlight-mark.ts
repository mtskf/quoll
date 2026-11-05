// Obsidian-style `==highlight==` inline mark — a custom @lezer/markdown
// extension modelled EXACTLY on the built-in GFM `Strikethrough` (`~~`), with
// `==` (char code 61) delimiters of length 2. Defined ONCE here and registered
// in BOTH parser configs:
//   - webview editor language: src/webview/cm/markdown.ts
//   - shared parse-only path: src/markdown/gfm-parser.ts
// Both share this rule so they agree on Highlight/HighlightMark spans, pinned
// by test/webview/highlight-parity.test.ts. Whole trees may differ because the
// editor additionally nests code sub-languages.
//
// Imports stay within @lezer/* so the shared parser remains independent of
// the CodeMirror editor stack. The style tag is inert metadata until a
// HighlightStyle consumes it in the webview theme.
//
// `highlightTag` is a fresh `Tag.define()` (no ancestry → cannot leak into
// prose highlighting, and prose tags cannot match it — cf. the tag-ancestry
// leak documented for code tokens). The webview's theme.ts HighlightStyle maps
// it to the highlighter background.
//
// `DelimiterType` is a PUBLIC type export of @lezer/markdown (dist/index.d.ts
// export list carries `type DelimiterType`), so the type-only import is stable
// API — NOT a reach into internals.
import { Tag } from "@lezer/highlight";
import type { DelimiterType, MarkdownExtension } from "@lezer/markdown";

/** Highlight-span highlight tag. Consumed by src/webview/cm/theme.ts. */
export const highlightTag = Tag.define();

// `==` delimiter. Punctuation flanking rules mirror Strikethrough so `== x ==`
// vs `==x==` open/close correctly. `126`→`61` and the `~`→`=` guards are the
// only substantive edits versus the upstream Strikethrough source.
const HighlightDelim: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

// Mirrors @lezer/markdown's private `Punctuation` regex VERBATIM (it is not
// exported): upstream builds `/[\p{S}|\p{P}]/u` (dist/index.js). Unicode
// property escapes are supported in the extension's target (esbuild + modern
// V8/Electron), so no ASCII-fallback branch is needed here. Drift from upstream
// is caught by the Highlight-tracks-Strikethrough flanking parity test.
const Punctuation = /[\p{S}|\p{P}]/u;

export const highlightMarkExtension: MarkdownExtension = {
  defineNodes: [
    // The `style` selector `"Highlight/..."` tags the highlight's inline CONTENT
    // with highlightTag (mirrors Strikethrough's `{ "Strikethrough/...":
    // tags.strikethrough }`). theme.ts's HighlightStyle paints it; inert in the
    // shared parse-only path. Consolidated here so there is a
    // single source of the node definition.
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark" },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        // `=` == 61. Need `==` here and NOT a third `=` immediately after — the
        // exact shape of Strikethrough's `~~`/three-tilde guard (byte-identical:
        // `126`→`61`). NB this does not uniformly reject `===` runs: the parser
        // rescans from pos+1, so `===x===` still forms a highlight — the `==`
        // marks land at [1,3) and [5,7), wrapping the content `x=` (Highlight
        // spans [1,7)). This is the MEASURED behaviour pinned by the span test;
        // it is NOT identical to Strikethrough at start-of-input
        // (`~~~x~~~` strikes nothing there), so the parity test deliberately
        // covers only the common `==body==` flanking shape.
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) {
          return -1;
        }
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter)
        );
      },
      after: "Emphasis",
    },
  ],
};
