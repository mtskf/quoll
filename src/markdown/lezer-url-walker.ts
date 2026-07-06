// Lezer-based URL extraction + allowlist gate. Builds the GFM parser
// DIRECTLY from @lezer/markdown (a direct dependency) by configuring the
// pure CommonMark parser with the same extension set — GFM, Subscript,
// Superscript, Emoji — that @codemirror/lang-markdown's `markdownLanguage`
// layers on. The tree shape for every gated node name is identical (the
// props @codemirror/lang-markdown attaches are metadata-only: fold /
// indent / heading / languageData facets), so this swap keeps the whole
// @codemirror editor stack (@codemirror/view + state + language +
// autocomplete + lang-html/css/javascript) OUT of the host bundle
// (dist/extension.cjs). We deliberately skip the `parseCode` wrapper that
// `markdown()` adds: no code sub-languages are configured here, and both
// fenced-code bodies and raw HTML are opaque to this walker (see the raw
// HTML note below), so no gated URL form is lost.
// A single tree-cursor walk gates every URL-emitting node through
// decodeMarkdownDestination + isAllowedUrl:
//   - Link / Image with a URL child (inline form).
//   - Autolink.
//   - LinkReference (definition block) - EVERY definition, including
//     shadowed dupes, because all the bytes land on disk regardless of
//     CommonMark's first-wins resolver semantics.
//
// Reference USE-SITES (shortcut / collapsed / full / image-reference)
// are intentionally NOT resolved: their destination is the URL of the
// definition they point at, which the walker already gates. Skipping
// the resolver removes label normalization, an empirical-Lezer-shape
// verification step, and a class of vacuous tests.
//
// GFM bare-URL autolinks (`www.…` / `http://…` WITHOUT angle brackets)
// parse as a bare URL node directly under Paragraph — NOT an Autolink
// node — so they fall outside the four arms above by design, and this is
// safe rather than a gap: GFM only bare-autolinks http / https / www /
// mailto (all allowlist-permitted) schemes, so a dangerous scheme like
// `javascript:` is never lifted into a link node to begin with. Angle-
// bracket autolinks `<scheme:…>` DO produce Autolink(URL) and are gated
// by the second arm. (Identical in both the old @codemirror/lang-markdown
// parser and this pure-@lezer/markdown one — GFM was always present.)
//
// Decoder order (decodeBackslashEscapes -> decodeCharacterReferences)
// matches CommonMark's definition sequence (escape first, then char-ref).
// Do not swap without re-running the full security matrix, as future
// grammar changes may introduce ordering dependencies. We do not aim for
// byte-identity with mdast's reference parser; we aim for fail-closed gating.
//
// Raw HTML: attribute URLs inside HTMLBlock / HTMLTag nodes are NOT
// extracted. Raw HTML is opaque source text — outside the Markdown
// URL-form contract. The render layer (downstream of this gate) is
// responsible for keeping it inert.
//
// PARSER is a module-level singleton: @lezer/markdown's parser is
// stateless across .parse() calls (the Tree it returns owns its
// state), so re-constructing per-call buys nothing. Tests that need a
// fresh import via vi.doMock() call vi.resetModules() BEFORE
// vi.doMock() so the singleton's cached export is invalidated; this
// ordering is what test/markdown/validate-for-write.test.ts uses.

import { Emoji, GFM, parser, Subscript, Superscript } from "@lezer/markdown";
import { TreeFragment } from "@lezer/common";
import type { ChangedRange } from "@lezer/common";

import type { MarkdownError } from "./errors.js";
import { isAllowedUrl } from "./url-allowlist.js";
import { decodeMarkdownDestination } from "./url-decode.js";

// Re-export so existing consumers (e.g. test/markdown/lezer-url-walker.test.ts
// and src/markdown/validate-for-write.ts) keep their import path. The
// pure decoder helpers were extracted to src/markdown/url-decode.ts so
// the webview's click-to-open handler can decode without dragging the
// host-side Lezer parser into the webview bundle.
export { decodeMarkdownDestination };

const PARSER = parser.configure([GFM, Subscript, Superscript, Emoji]);

// The parse-tree type taken from the parser's own return type, so the
// incremental cache + tests stay honest if the parser's tree shape changes.
type ParseTree = ReturnType<typeof PARSER.parse>;

// Parse `content` with the GFM-configured Markdown parser, optionally reusing
// unchanged subtrees from a previous parse via `fragments`. `.parse` is
// synchronous and returns a COMPLETE tree (no CodeMirror time budget), so a
// fragment-reused parse yields the same node structure as a fresh parse — the
// invariant the incremental write-gate rests on. Exported for the incremental
// finder and the parity/reuse-guard tests.
export function parseMarkdown(content: string, fragments?: readonly TreeFragment[]): ParseTree {
  return PARSER.parse(content, fragments);
}

// One conservative changed range bracketing where two strings differ: the
// common-prefix length as the start, the common-suffix (bounded so it never
// overlaps the prefix in either string) as the tail. UTF-16 code units, the
// unit Lezer/CodeMirror positions use. A superset of the real edit is enough
// for `TreeFragment.applyChanges` to know which fragments to drop; a
// slightly-wide range only reduces reuse, never correctness. Identical strings
// yield an empty range (full reuse). Mirrors the webview lint engine's
// `diffRange` (src/webview/cm/lint/engine.ts) — duplicated deliberately across
// the host/webview bundle boundary rather than coupling the two bundles.
export function diffRange(a: string, b: string): ChangedRange {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(a.length - prefix, b.length - prefix);
  while (
    suffix < maxSuffix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return { fromA: prefix, toA: a.length - suffix, fromB: prefix, toB: b.length - suffix };
}

// SyntaxNode is the cursor node shape from @lezer/common. `@lezer/common` is a
// direct dependency (added for the lint incremental parser in #66), so
// `TreeFragment` is imported directly above. We still derive `SyntaxNode` from
// `ReturnType<typeof PARSER.parse>["topNode"]` (rather than importing a
// `SyntaxNode` type name) so change-detection stays at the call site if the
// parser's tree shape churns upstream: if the parser's tree shape changes, this
// alias breaks at the call site, which is the change-detection signal we want.
type SyntaxNode = ReturnType<typeof PARSER.parse>["topNode"];

/**
 * Walk `content` and return the first MarkdownError encountered while
 * gating decoded URL destinations through the allowlist, or null if
 * all URLs are safe. Tests assert "an unsafe URL exists" (code +
 * message), NOT "the first by document position."
 */
export function findUnsafeUrl(content: string): MarkdownError | null {
  return walkTreeForUnsafeUrl(parseMarkdown(content), content);
}

// The pure tree walk, split out of findUnsafeUrl so the incremental finder can
// feed a fragment-reused tree through the IDENTICAL gating logic. Given the
// same (tree, content) it returns the same verdict as a fresh walk.
export function walkTreeForUnsafeUrl(tree: ParseTree, content: string): MarkdownError | null {
  let firstError: MarkdownError | null = null;
  const cursor = tree.cursor();
  do {
    if (firstError) {
      break;
    }
    firstError = checkNode(cursor.node, content);
  } while (cursor.next());
  return firstError;
}

function checkNode(node: SyntaxNode, content: string): MarkdownError | null {
  // The three URL-emitting node arms - Autolink, inline Link/Image with
  // a URL child, and LinkReference definition. Reference use-sites
  // (Link/Image without a URL child) are deliberately ignored: their
  // destination lives on the definition, already gated by the third
  // arm.
  if (
    node.name !== "Autolink" &&
    node.name !== "Link" &&
    node.name !== "Image" &&
    node.name !== "LinkReference"
  ) {
    return null;
  }
  const urlNode = findChild(node, "URL");
  if (!urlNode) {
    // Reference use-site or definition with no URL child: nothing to
    // gate at this node. The other definition arms still gate the
    // actual URL where it lives.
    return null;
  }
  const decoded = decodeMarkdownDestination(content.slice(urlNode.from, urlNode.to));
  if (!isAllowedUrl(decoded)) {
    return unsafeUrlError(decoded);
  }
  return null;
}

// ---- helpers ----------------------------------------------------------------

function findChild(node: SyntaxNode, name: string): SyntaxNode | null {
  let child = node.firstChild;
  while (child) {
    if (child.name === name) {
      return child;
    }
    child = child.nextSibling;
  }
  return null;
}

// decodeMarkdownDestination + its private helpers (decodeBackslashEscapes,
// decodeCharacterReferences, decodableCodePoint, NAMED_ENTITIES,
// SURROGATE_LOW/HIGH, MAX_CODE_POINT, UNDECODABLE_SUBSTITUTE) were
// extracted to src/markdown/url-decode.ts (Slice C4b Task 3). The full
// rationale comments (decoder order, NUL substitution, named-entity
// trailing-`;` policy, etc.) live there verbatim. The function is
// re-exported above so existing import paths stay green.

function unsafeUrlError(url: string): MarkdownError {
  // Sanitize the URL for BOTH the message and the detail field.
  // The message goes to the user-visible toast (VS Code's
  // showError); detail.url goes to the log channel and may be
  // JSON-serialized into OutputChannel or external aggregators. Raw
  // NUL / control bytes from the UNDECODABLE_SUBSTITUTE pathway can
  // either truncate display strings or surprise downstream consumers
  // that interpolate detail.url directly. Apply the same sanitize
  // regex to both surfaces -- we already lost source-byte fidelity
  // at the decoder boundary (the URL here is post-decode,
  // post-NUL-substitution), so preserving control bytes anywhere on
  // this surface has no value.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional - strip control bytes from the user-visible toast.
  const sanitized = url.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
  return {
    code: "unsafe_url",
    message: `URL is not in the allowlist: ${sanitized}`,
    detail: { url: sanitized },
  };
}
