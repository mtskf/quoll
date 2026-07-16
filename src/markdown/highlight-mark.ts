// Obsidian-style `==highlight==` inline mark — a custom @lezer/markdown
// extension modelled EXACTLY on the built-in GFM `Strikethrough` (`~~`), with
// `==` (char code 61) delimiters of length 2. Defined ONCE here and registered
// in BOTH parser configs:
//   - webview editor language: src/webview/cm/markdown.ts
//   - host write-gate:         src/markdown/lezer-url-walker.ts
// The two parsers diverge deliberately elsewhere (bundle size — the host omits
// the CodeMirror editor stack), but they share THIS rule so both agree on the
// `Highlight`/`HighlightMark` inline-node behaviour. That is not whole-tree
// parity (the webview additionally nests code sub-languages etc.); the shared
// rule guarantees the Highlight span itself is produced identically, pinned by
// the host↔webview Highlight-parity test (test/webview/highlight-parity.test.ts).
//
// IMPORTS ARE @lezer/* ONLY — no @codemirror/* — because this file is bundled
// host-side too (dist/extension.cjs), and the host must not drag in the
// CodeMirror editor stack. `defineNodes.style` is a @lezer/highlight tag (a
// NodeProp) — inert metadata in the host, live only where a HighlightStyle
// consumes it (the webview's theme.ts). @lezer/highlight is already a
// transitive host dep (GFM's own style tags), so it adds no new host surface.
//
// `highlightTag` is a fresh `Tag.define()` (no ancestry → cannot leak into
// prose highlighting, and prose tags cannot match it — cf. the tag-ancestry
// leak documented for code tokens). The webview's theme.ts HighlightStyle maps
// it to the highlighter background; the host bundles the tag as inert metadata.
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
    // host. Consolidated here (NOT deferred to the webview config) so there is a
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
        // rescans from pos+1, so `===x===` still forms a highlight around the
        // inner `=x=` (Highlight[1,7)). This is the MEASURED behaviour pinned by
        // the span test; it is NOT identical to Strikethrough at start-of-input
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
