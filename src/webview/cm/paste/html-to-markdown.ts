// Pure converter: an HTML `text/html` clipboard fragment → `{ markdown,
// emittedMarkdownSyntax }`, or `null` when there is nothing convertible. No
// dependency, no side effects — `DOMParser` is a webview/browser global
// (happy-dom provides it under test), so this stays inside Quoll's supply-chain
// default-deny.
//
// TWO output channels, interpreted by the clipboard coordinator:
//  - `null` — nothing convertible. `decideRichPaste` returns null, and the
//    clipboard's own text (if any) is pasted by `decideClipboardPaste`.
//  - `emittedMarkdownSyntax === false` — the walk produced escaped text and line
//    structure only. When `text/plain` or `text/uri-list` exists,
//    `decideClipboardPaste` inserts those clipboard bytes. This module's escaped
//    rendering is used only when neither flavour exists (an HTML-only clipboard).
//    See the `HtmlToMarkdownResult` docblock at the bottom.
//
// Design notes (why each choice, so a future edit doesn't regress it):
//  - Structure is read via an EXPLICIT direct-child walk (Array.from(childNodes)),
//    NOT live collections — happy-dom leaks nested-content through some live
//    collections (see html-table-to-gfm.ts), and an explicit snapshot is also
//    immune to any incidental mutation during the walk.
//  - Text is escaped so pasted text is literal, on EVERY line — not just a
//    block's first line — because a `<br>` or a text-node newline could
//    otherwise smuggle an active marker onto a later line. Escaping hits the
//    inline-active characters (`` ` * _ [ ] < ~ = & | ``) and line-start block
//    markers; scheme bytes (`:` `/` `.`) and alphanumerics are left alone, so a
//    bare `http(s)://`/`www.` URL built only from those still autolinks. A URL
//    that also carries an inline-active byte (`_`/`&`/`=` in a query string, say)
//    has it escaped to stay literal — safety over fidelity, matching escapeCell:
//    it may curtail the bare autolink but can never activate an unintended
//    construct. Pasted text therefore never activates a construct that the same
//    text typed by hand would not. NOTE this escaping is precisely what makes the
//    conversion unusable for a syntax-free fragment — Markdown the user typed by
//    hand would come back as `\- \[ \]`. When `emittedMarkdownSyntax === false`,
//    the coordinator uses the clipboard's plain or URI-list text when available;
//    this escaped rendering is used for an HTML-only clipboard.
//  - Source visibility uses `blankAfterInvisible` over SKIP_TAGS-filtered text,
//    with an <hr> clause for text-free rules. Tables are emitted independently and
//    use per-cell text to determine richness; block serialization guards residue.
//  - Collection never mutates the DOM, so traversal caps trivially precede mutation.
//  - Never throws to the handler: caps throw an internal sentinel (`CapExceeded`);
//    `htmlToMarkdown` wraps the whole walk in a try/catch that returns `null` for
//    ANY thrown value, so the handler always has a safe defer-to-plain-paste path.

import { isAllowedUrl } from "../../../markdown/url-allowlist.js";
import { encodeMarkdownDestination } from "../../../markdown/url-decode.js";
import { MAX_LIST_NUMBER } from "../list/list-transform.js";
import { type BlockNode, fenceCode, type PreparedInline, serializeBlockNodes } from "./block-ir.js";
import { SKIP_TAGS, tableElementToGfm } from "./html-table-to-gfm.js";
import {
  BOLD,
  CapExceeded,
  foldBreaksToSpaces,
  HARD_BREAK,
  type InlineAtom,
  InlineRepairCapExceeded,
  ITALIC,
  type RepairBudget,
  type StyleMask,
  serializeInlineRuns,
} from "./inline-runs.js";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const MAX_HTML_INPUT_CHARS = 2 * 1024 * 1024; // 2 MiB source HTML
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024; // bound total emitted Markdown (checked incrementally)
const MAX_NODES = 50_000; // total element visits
// Total emphasis-repair work per conversion, in chars re-serialised (see
// `RepairBudget`). Independent repairs are batched per pass, so the cost scales
// with cascade depth x run length: ordinary pastes settle in one or two passes,
// and this bounds a crafted cascade before the plain-text fallback.
const MAX_REPAIR_WORK = 4_000_000;
// Recursion depth cap for BOTH inline and block walks. 32 is far beyond any real
// document (nobody nests 32 blockquotes/lists or 32 inline emphasis spans), yet
// low enough that the transient peak memory of wrapper re-indentation
// (quote prefixes and list indentation rebuild a copy of the child body at each
// level) is bounded to `MAX_DEPTH × MAX_OUTPUT_CHARS` and then freed. A deeper
// fragment throws CapExceeded → `null` → plain-text paste (which handles the same
// bytes linearly). This is the guard against both call-stack exhaustion and
// wrapper-amplification memory blow-up.
const MAX_DEPTH = 32;

// `SKIP_TAGS` is imported from html-table-to-gfm.ts (single source of truth,
// shared because the rich converter reuses tableElementToGfm) — SCRIPT/STYLE/…
// plus form-control + embed elements whose text/value is not prose.

// The cap sentinel `CapExceeded` (imported from inline-runs.ts, so the inline
// serializer's repair-cap error is the same class) is thrown deep in the walk and
// caught by `htmlToMarkdown`, which returns `null` so the handler degrades to
// plain-text paste. It NEVER propagates to the DOM event handler.

export interface Ctx {
  nodes: number; // element visits
  outLen: number; // cumulative leaf characters, before final wrapper formatting
  repair: RepairBudget; // shared by every inline run of this conversion
}

function bump(ctx: Ctx): void {
  ctx.nodes++;
  if (ctx.nodes > MAX_NODES) {
    throw new CapExceeded();
  }
}

/** Count emitted output at its LEAF source (inline text/code/br/link, and the two
 *  non-inline leaves: table GFM + `<pre>` body) so the running total is not
 *  inflated by re-counting already-counted content as it bubbles up through list
 *  / blockquote wrappers. Bounds cumulative output INCREMENTALLY — a small input
 *  that amplifies (table colspan/rowspan expansion into up to 50k cells per
 *  table, over many tables) aborts mid-build instead of materialising gigabytes
 *  before a final length check. Returns `s` so it can wrap a return expression. */
function count(ctx: Ctx, s: string): string {
  ctx.outLen += s.length;
  if (ctx.outLen > MAX_OUTPUT_CHARS) {
    throw new CapExceeded();
  }
  return s;
}

/** Backslash-escape Markdown-inline-active characters (the SAME set as escapeCell
 *  in html-table-to-gfm.ts) so text renders literally. `\` first so later escapes
 *  are not doubled. `<` escaped so literal `<tag>`-looking text cannot become
 *  inline raw HTML / an autolink. `|` escaped because an unescaped pipe plus a
 *  following delimiter-shaped line (`h1 | h2` then `:-|:-`, e.g. via a `<br>`)
 *  forms a GFM table — pasted prose must not fabricate a block table. `>` is NOT
 *  escaped here (inert mid-line — handled at line start by escapeMarkers),
 *  matching the table converter's proven policy. */
function escapeInline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[`*_[\]<~=&|]/g, "\\$&");
}

/** Escape block-start-only markers at EVERY line start (multiline) so a `- `,
 *  `# `, `> `, `+ `, or `1.`/`1)` at the head of ANY line — including a line
 *  produced by a `<br>` hard break — renders as literal text rather than opening
 *  a heading / blockquote / list / etc. `*`/`` ` ``/`_`/`~`/`=`/`<`/`&` are
 *  already escaped everywhere by escapeInline; only `#`/`>`/`+`/`-` and the
 *  ordered-list marker are line-start-sensitive. */
function escapeMarkers(text: string): string {
  return text
    .replace(/^(\s*)([#>+-])/gm, "$1\\$2")
    .replace(/^(\s*)(\d{1,9})([.)])(\s|$)/gm, "$1$2\\$3$4");
}

/** Normalise a run of SOURCE text to what a reader actually sees: drop the
 *  zero-width characters, then collapse all whitespace runs (incl. newlines) to a
 *  single space — HTML's own inline whitespace behaviour. Applied to text nodes
 *  and to the emptiness predicate, never to a `<pre>` BODY, which the block path
 *  reads verbatim, so an interior newline cannot form indented code or smuggle an
 *  unescaped line start; real breaks come only from `<br>` and block structure.
 *
 *  Deletes ONLY the pure width-less SPACING class — U+200B ZERO WIDTH SPACE and U+FEFF
 *  (BOM / zero-width no-break space) — because these occupy no width AND carry no glue
 *  semantics, so folding one into a space would insert a gap between two letters that
 *  touch. U+200C ZERO WIDTH NON-JOINER, U+200D ZERO WIDTH JOINER, and U+2060 WORD JOINER
 *  are DELIBERATELY PRESERVED here: they are also width-less but they carry meaning —
 *  U+200D glues emoji ZWJ sequences (a family / profession / flag emoji), U+200C is
 *  required orthography in Persian and Indic scripts, and U+2060 is a no-break joiner
 *  that keeps two glyphs from separating — so deleting them on the emit path corrupts
 *  real text on disk (a family emoji splits into three people; a Persian word loses a
 *  letter; a no-break pair comes apart). This runs on EVERY emitted text node, so it is
 *  fidelity-first. U+00A0 needs no clause — it IS `\s`.
 *
 *  EMPTINESS is a SEPARATE question, answered by `blankAfterInvisible`, which strips
 *  the `\p{Default_Ignorable_Code_Point} ∪ \p{Cf}` union (the joiners included, plus bidi
 *  marks, variation selectors and the interlinear controls) because a lone one is visually
 *  empty even though a joiner WITHIN text is load-bearing. Splitting the two is what lets
 *  output keep joiners while
 *  `hasVisibleContent` still rejects a contenteditable's emptied block — the leftover
 *  container (`<h1>&#8203;</h1>`, `<h1>&#8205;</h1>`) the emptiness guard exists to
 *  reject, which `String.prototype.trim()` does not strip. */
function collapseWs(text: string): string {
  return text.replace(/[\u200B\uFEFF]/g, "").replace(/\s+/g, " ");
}

/** Emptiness normaliser: strip the invisible/ignorable formatting chars — the
 *  `\p{Default_Ignorable_Code_Point} ∪ \p{Cf}` (Format) union (U+00AD SOFT HYPHEN, the
 *  zero-width joiners ZWSP/ZWNJ/ZWJ/WJ, U+FE00–FE0F VARIATION SELECTORs, the bidi
 *  marks/isolates LRM/RLM/ALM + U+2066–2069, the interlinear controls U+FFF9–FFFB, BOM,
 *  and any future format/ignorable char) — collapse whitespace, trim, and report whether
 *  nothing visible remains. Distinct from `collapseWs` (the emit path, which PRESERVES
 *  joiners — WJ included — and variation selectors for fidelity): a lone one reads
 *  as blank here so an otherwise-empty container holding only one cannot flip
 *  `emittedMarkdownSyntax`. THE single answer to "is this text visually empty" within this
 *  file — routed
 *  through by every emptiness decision in this module: `hasVisibleContent`, the table
 *  per-cell and blockquote/list wrapper own-text richness checks,
 *  the CODE/A/PRE/heading/blockquote/list-item residue guards, and the inline-run
 *  blank-text / non-`<li>` list-child checks — so none grows its own rule. ⚠️ inline-runs.ts's `INVISIBLE_TOKEN` hand-mirrors the same
 *  `\p{Default_Ignorable_Code_Point} ∪ \p{Cf}` union (it classifies atoms, not strings), so
 *  the two must be changed together. */
function blankAfterInvisible(text: string): boolean {
  return (
    text
      // Invisible / ignorable formatting chars stripped by the UNION of two Unicode
      // properties — `\p{Default_Ignorable_Code_Point} ∪ \p{Cf}` (Format) — not a
      // hand-enumerated list: two bounded, self-updating classes that together cover the
      // zero-width joiners (ZWSP/ZWNJ/ZWJ/WJ/BOM), U+00AD SOFT HYPHEN, the U+FE00–FE0F
      // VARIATION SELECTORs, the bidi marks/isolates (LRM/RLM/ALM, U+2066–2069), the
      // interlinear annotation controls U+FFF9–FFFB (`Cf` but NOT Default_Ignorable — the
      // reason `\p{Cf}` is unioned in), and any future format/ignorable char — every char
      // that reads as blank. It matches NONE of letter/space/NBSP/heart/emoji/hyphen/CJK.
      // Written as ALTERNATION (`A|B`), not a `[…]` char class, so biome's
      // noMisleadingCharacterClass does not flag the property escapes.
      //   BOUNDARY: this is the format+ignorable class and stops there. A glyph that
      // merely RENDERS blank but is a SYMBOL — e.g. U+2800 BRAILLE PATTERN BLANK — is
      // CONTENT, deliberately excluded: stripping symbol categories would be the
      // unbounded direction this predicate's design forbids.
      //   This is the EMPTINESS path ONLY; `collapseWs` (the OUTPUT path) must NOT strip
      // these — VS16 is load-bearing in emoji presentation (`❤️` = U+2764 U+FE0F), joiners
      // glue emoji/orthography, and the bidi marks order real mixed-direction text.
      .replace(/\p{Default_Ignorable_Code_Point}|\p{Cf}/gu, "")
      .replace(/\s+/g, " ")
      .trim() === ""
  );
}

/** Concatenate every descendant text node of `el` VERBATIM, skipping `SKIP_TAGS`
 *  subtrees (whose text is not prose and must never enter output or count as visible).
 *  Explicit-stack DFS, the same shape as `collectCellText` in html-table-to-gfm.ts.
 *  Four callers: the `hasVisibleContent` emptiness predicate and the table PER-CELL
 *  richness check both feed it to `blankAfterInvisible` (so `<style>`/`<textarea>` text
 *  no reader sees never counts as visible), and the two branches that emit a body from
 *  `textContent` rather than `collectInline` — `<pre>` (verbatim) and inline `<code>`
 *  (then `collapseWs`'d) — read through it so SKIP_TAGS text cannot leak into a fenced /
 *  inline-code body. */
function skipTagsText(el: Element): string {
  const parts: string[] = [];
  const stack: Node[] = [];
  const seed = el.childNodes;
  for (let i = seed.length - 1; i >= 0; i--) {
    stack.push(seed[i]);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      continue;
    }
    const child = node as Element;
    if (SKIP_TAGS.has(child.tagName)) {
      continue;
    }
    const kids = child.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push(kids[i]);
    }
  }
  return parts.join("");
}

/** Write `url` (already `isAllowedUrl`-approved) as a CommonMark link destination
 *  that decodes back to the same URL. Newlines are stripped first — the encoder
 *  cannot carry them (isAllowedUrl already rejects control bytes; belt-and-
 *  braces). */
function markdownDestination(url: string): string {
  return encodeMarkdownDestination(url.replace(/[\r\n]/g, ""));
}

/** Length of the longest consecutive backtick run in `text` (0 when none) — the
 *  basis for choosing a code fence one backtick longer than anything inside. */
function longestBacktickRun(text: string): number {
  const runs = text.match(/`+/g);
  return runs ? Math.max(...runs.map((r) => r.length)) : 0;
}

/** Fence an inline-code span: a run of backticks one longer than the longest
 *  backtick run inside the content, space-padded when content borders a backtick
 *  (CommonMark rule). Content is verbatim (never escaped). */
function inlineCode(text: string): string {
  const longest = longestBacktickRun(text);
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 || text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The inline-style declarations that cancel the emphasis a tag implies, keyed by
 *  the property each tag is about. `400` is the numeric spelling of `normal`;
 *  `font-style` has no numeric form, so it lists only the keyword. Deliberately NOT
 *  a general numeric-weight comparison — `font-weight: 300` on a `<b>` is not a
 *  producer idiom, and a weight parser here would be the "teach the predicate more
 *  cases" direction this file has been burned by. `(?:^|;)` is what keeps the match
 *  to a whole declaration, so a vendor-prefixed `-webkit-font-weight` cannot
 *  satisfy it. */
const EMPHASIS_CANCELLED_BY = {
  "font-weight": /(?:^|;)\s*font-weight\s*:\s*(?:normal|400)\b/i,
  "font-style": /(?:^|;)\s*font-style\s*:\s*normal\b/i,
} as const;

/** Does this `<b>`/`<strong>` (resp. `<i>`/`<em>`) style away the emphasis its tag
 *  implies? Google Docs wraps EVERY clipboard copy in
 *  `<b style="font-weight:normal" id="docs-internal-guid-…">`. A whole-block copy
 *  puts `<p>`s inside that wrapper, so the block walk recurses and never reaches
 *  the emphasis case; a PARTIAL-LINE selection puts only `<span>`s there, folds
 *  into the inline run and lands on `B` below — which is how `- [ ] buy milk`
 *  copied out of Docs came back as `**\- \[ \] buy milk**`: bold that exists
 *  nowhere in the source, plus the flag that defeats the caller's no-syntax defer.
 *
 *  Stated once for all four tags rather than special-casing the Docs `id`: the rule
 *  is "styled-away emphasis is not emphasis", and other producers emit the shape
 *  too. Reads the style ATTRIBUTE, never `el.style` / `getComputedStyle` — happy-dom's
 *  CSSOM silently drops values (two standing repo memories), so a CSSOM read would
 *  be behaviour no unit test could pin. */
function styleCancelsEmphasis(el: Element, prop: keyof typeof EMPHASIS_CANCELLED_BY): boolean {
  return EMPHASIS_CANCELLED_BY[prop].test(el.getAttribute("style") ?? "");
}

// The hard-break token (`HARD_BREAK`, backslash + newline) is exported by
// inline-runs.ts, the one place that emits it: `collectInline` turns a `<br>` into a
// break atom (counted as the token's length), and `serializeInlineRuns` renders it.
// Edge trimming, the link-label fold and the heading fold (`inlineMarkdown` 'heading'
// mode → `foldBreaksToSpaces`) all happen on atoms there — a break unit at a run edge
// is dropped, one in a label or heading becomes a space — so no string scan here has
// to keep the token's `\` and `\n` together. The remaining string-level readers
// (the list-item and blockquote residue guards) fold the whole token.
//
// A `\n` in an inline fragment ALWAYS comes from a `<br>`, because EVERY text node
// on the inline path goes through `collapseWs`, which turns each whitespace run into
// a single space. Note the reason is `collapseWs`, NOT "`<pre>` is handled
// elsewhere": only DIRECT children are block-tested, so a `<pre>` under an inline
// ancestor (`<em><span><pre>a\nb</pre></span></em>`) does reach `collectInline` —
// its body simply arrives as a text node and loses its newlines like any other. Do
// not skip `collapseWs` anywhere on the inline path on the assumption that `<pre>`
// cannot appear there.

/** Collect inline content (children of a block) as styled atoms for
 *  `serializeInlineRuns`, appending to `out`. `style` is the emphasis inherited
 *  from the ancestors. Text is whitespace-collapsed (never escaped here), and
 *  unknown inline elements recurse transparently. `depth` guards against
 *  call-stack exhaustion on pathological nesting. Leaves are counted where they
 *  are read — a text leaf counts its collapsed UNESCAPED text (escaping happens
 *  later, in the serializer; it at most doubles the text, and the final output
 *  length check stays authoritative). Emphasis tags only change the style mask:
 *  markers, their placement and the visually-empty case are the serializer's job. */
export function collectInline(
  node: Node,
  depth: number,
  ctx: Ctx,
  style: StyleMask,
  out: InlineAtom[]
): void {
  if (depth > MAX_DEPTH) {
    throw new CapExceeded();
  }
  if (node.nodeType === TEXT_NODE) {
    const text = count(ctx, collapseWs(node.textContent ?? ""));
    if (text !== "") {
      out.push({ kind: "text", text, style });
    }
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return;
  }
  const el = node as Element;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) {
    return;
  }
  bump(ctx);
  if (tag === "BR") {
    count(ctx, HARD_BREAK);
    out.push({ kind: "break", style });
    return;
  }
  if (tag === "CODE") {
    // Inline <code> (a <code> child of <pre> is handled by the block path). An
    // EMPTY one renders as the two-backtick `` — non-empty output from a container
    // holding nothing. Body is read through `skipTagsText` so a `<style>`/`<textarea>`
    // beside the code contributes nothing, then `collapseWs` (emit path) collapses it.
    // `blankAfterInvisible(body)` is the SUFFICIENT / PRIMARY gate; `!hasVisibleContent(el)`
    // is a REDUNDANT twin — a proven subset, not empirically load-bearing — KEPT for
    // CODE↔A consistency + defense-in-depth (should collapseWs ever leave a visible char in
    // a body its source counted blank).
    //  - `blankAfterInvisible(body)` (the residue) rejects everything that must emit
    //    nothing: a lone-joiner `<code>&#8205;</code>` (the emit-path collapseWs preserves
    //    joiners, so `body` keeps it — full-strip, not `.trim()`, is what rejects it) AND
    //    the `<hr>`-clause case (`<code> <hr> </code>` / `<code><hr>&#8205;</code>`) where
    //    the predicate passes on its `<hr>` clause but the body has nothing to fence.
    //  - `!hasVisibleContent(el)` cannot fire where the residue does not: whenever it is
    //    true (blankAfterInvisible(skipTagsText) AND no `<hr>`), `body` is a collapseWs
    //    subset of that same text, so blankAfterInvisible(body) already holds. A clean
    //    subset proof — the twin can never be the sole gate that fires.
    const body = collapseWs(skipTagsText(el));
    if (!hasVisibleContent(el) || blankAfterInvisible(body)) {
      return;
    }
    out.push({ kind: "code", markdown: count(ctx, inlineCode(body)), style });
    return;
  }
  const children = (childStyle: StyleMask, into: InlineAtom[]): void => {
    for (const child of Array.from(el.childNodes)) {
      collectInline(child, depth + 1, ctx, childStyle, into);
    }
  };
  switch (tag) {
    // A tag whose own style cancels it is transparent, exactly like an unknown
    // inline element. See styleCancelsEmphasis.
    case "STRONG":
    case "B":
      children(styleCancelsEmphasis(el, "font-weight") ? style : style | BOLD, out);
      return;
    case "EM":
    case "I":
      children(styleCancelsEmphasis(el, "font-style") ? style : style | ITALIC, out);
      return;
    case "A": {
      // The label is collected link-relative (base style 0); the outer style
      // stays on the link atom.
      const label: InlineAtom[] = [];
      children(0, label);
      const href = el.getAttribute("href") ?? "";
      // A rejected destination inlines the bare label (no syntax emitted), with the
      // outer style OR-ed in.
      //
      // So does an EMPTY <a>: `[](url)` is a link the reader cannot see or click,
      // and non-empty output from a container holding nothing. The commonest source
      // is a marketing mail's tracking pixel (`<a href="…"><img src="p.gif"></a>`),
      // which rides along beside otherwise plain text. Same treatment as the other
      // empty containers: label only (here, nothing), no syntax flag.
      //
      // `blankAfterInvisible(labelText(label))` is the SUFFICIENT / PRIMARY gate;
      // `!hasVisibleContent(el)` is a REDUNDANT twin — KEPT for CODE↔A consistency +
      // defense-in-depth, NOT empirically load-bearing.
      //  - The residue rejects a link with nothing to show: an empty `<a>` / tracking
      //    pixel, a lone-joiner or whitespace-only label the emit path preserved, and
      //    the `<hr>`-clause case (`<a href> <hr> </a>` / `<a href><hr>&#8205;</a>`). The
      //    SAME full-strip rule, not `.trim()`.
      //  - `!hasVisibleContent(el)` cannot fire where the residue does not: by case
      //    analysis, whenever the twin is true (skipTagsText blank AND no `<hr>`), every
      //    inline leaf under it collects from that same blank source to DI/whitespace-only
      //    text, so the label is blank too. Belt-and-braces on the source, never the sole
      //    gate that fires.
      if (
        !isAllowedUrl(href) ||
        !hasVisibleContent(el) ||
        blankAfterInvisible(labelText(label, ctx))
      ) {
        for (const atom of label) {
          out.push({ ...atom, style: atom.style | style });
        }
        return;
      }
      out.push({ kind: "link", label, destination: markdownDestination(href), style });
      return;
    }
    default:
      children(style, out); // span/font/unknown inline → transparent
  }
}

/** Serialise one inline run (a segment's nodes) to Markdown through the atom IR:
 *  collect styled atoms, then let `serializeInlineRuns` place the markers, repair
 *  flanking and trim the run's edge spaces / breaks. A heading cannot hold a hard
 *  break, so `"heading"` turns each break into a single space first. Richness
 *  combines accepted code/link atoms with the emitted emphasis markers. */
function inlineMarkdown(
  nodes: readonly Node[],
  depth: number,
  ctx: Ctx,
  mode: "paragraph" | "heading"
): PreparedInline {
  const atoms: InlineAtom[] = [];
  for (const node of nodes) {
    collectInline(node, depth, ctx, 0, atoms);
  }
  const runAtoms = mode === "heading" ? foldBreaksToSpaces(atoms) : atoms;
  const result = serializeInlineRuns(runAtoms, {
    escapeText: escapeInline,
    trimEdges: true,
    repairBudget: ctx.repair,
  });
  return {
    markdown: result.markdown,
    rich:
      result.emittedSyntax || atoms.some((atom) => atom.kind === "code" || atom.kind === "link"),
  };
}

/** The label as the link would show it (breaks folded to a space), for the
 *  emptiness gate. */
function labelText(label: readonly InlineAtom[], ctx: Ctx): string {
  return serializeInlineRuns(foldBreaksToSpaces(label), {
    escapeText: escapeInline,
    trimEdges: false,
    repairBudget: ctx.repair,
  }).markdown;
}

const HEADINGS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

/** Elements that are block-level in HTML. (Named BLOCK_LEVEL_TAGS, not
 *  BLOCK_TAGS, to stay distinct from the unrelated `BLOCK_TAGS` local to
 *  html-table-to-gfm.ts — this module does not import it, but the two files are
 *  read side by side.) Used for two questions: (a) is THIS
 *  element a block (so it must not be folded into a sibling inline run — a
 *  `<div>` holding only a `<span>` is still its own line), and (b) does an
 *  unknown element carry block children (so it must recurse rather than
 *  flatten). The explicitly-handled tags (P / UL / OL / PRE / BLOCKQUOTE /
 *  TABLE / HR / H1-6) are listed too because (b) still asks about them.
 *
 *  Membership policy: aim for the HTML block-level container set, minus
 *  containers whose parent handler always consumes them — TR / TD / TH / THEAD /
 *  TBODY / TFOOT and CAPTION are deliberately absent, because a stray one is only
 *  reachable outside a <table>, where it carries no table meaning and folding is
 *  harmless. An omitted block tag silently folds back into the inline run — the
 *  exact bug this task fixes — so err toward listing a tag. Omission is the only
 *  failure mode; a wrongly-listed inline tag would merely give it its own line.
 *  Add to this set rather than introducing a second one. */
const BLOCK_LEVEL_TAGS = new Set([
  "P",
  "UL",
  "OL",
  "PRE",
  "BLOCKQUOTE",
  "TABLE",
  "HR",
  "DIV",
  "CENTER",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "ASIDE",
  "HEADER",
  "FOOTER",
  "NAV",
  "FIGURE",
  "FIGCAPTION",
  "ADDRESS",
  "DL",
  "DT",
  "DD",
  "DETAILS",
  "SUMMARY",
  "DIALOG",
  "FIELDSET",
  "LEGEND",
  "FORM",
  "HGROUP",
  "MENU",
  "SEARCH",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  // Block-level but normally consumed by its parent handler: `collectList`
  // walks `directChildrenByTag(list, "LI")`, so an <li> inside a ul/ol/menu never
  // reaches the tag dispatch that reads this set. Listed anyway for the STRAY
  // case — a fragment whose top level is bare <li>s, the ordinary result of a
  // copy that starts mid-list — which otherwise folded into one inline run and
  // came out glued together with no separator at all.
  "LI",
]);

/** Does this container hold anything a reader would see? Decided on the SOURCE
 *  element, never on the rendered Markdown: a rendered EMPTY container is not the
 *  empty string — a list renders `-`, a code span ``` `` ```, a link `[](url)`,
 *  and a `<br>`-only heading a stray `\` — so a per-branch "is the render empty"
 *  test has to re-derive a different wrong answer each time. Three review cycles
 *  found six such branches wrong; this is the one place that question is answered,
 *  and every branch that sets `emittedMarkdownSyntax` from a container routes
 *  through it FIRST — on that container, or (for `<ul>`/`<ol>`) on each `<li>` the
 *  list is composed of. Not "every branch below": `CODE` and `A` are declared above
 *  this point yet still route through it; `<table>` and the emphasis tags decide
 *  emptiness by the same `blankAfterInvisible` rule but do NOT call this function —
 *  the module header lists those two (plus `<hr>`, which opts out of the emptiness rule
 *  entirely) and why each is safe. An empty container that sets
 *  the flag defeats the caller's no-syntax defer and re-escapes Markdown the user
 *  typed by hand (`- [ ]` → `\- \[ \]`) — the bug this whole guard exists to stop.
 *
 *  ONE deliberate opt-out, stated here rather than left implicit at its branch:
 *  `<hr>`. It is a void element, so this predicate would answer "empty" for EVERY
 *  one of them and thematic breaks would stop converting altogether — and that is
 *  safe precisely because an `<hr>` holds nothing: it has no empty-vs-full variant,
 *  so there is no wrong answer for the predicate to give.
 *
 *  `<table>` is NOT gated by this predicate: the TABLE branch emits its grid
 *  UNCONDITIONALLY and reads richness from a per-cell `blankAfterInvisible` check, so
 *  a text-free spacer grid at top level is emitted (not rich). But a table NESTED in
 *  a predicate-gated container inherits THAT container's verdict — a text-free table
 *  inside a `<blockquote>`/`<li>` makes the wrapper read empty here and is dropped
 *  outright (`<blockquote><table>empty</table></blockquote>` → nothing), where the
 *  same table at top level emits its grid. That asymmetry is deliberate: the lost
 *  artefact is a text-free grid, and the alternative — a `querySelector("table")`
 *  clause — would re-open the content-loss direction the `<hr>` clause exists to
 *  close. See the TABLE branch comment for the per-cell richness rule. (When something
 *  ELSE keeps the wrapper alive here — its own text, or a buried `<hr>` satisfying the
 *  clause below — the nested text-free grid IS emitted, but the wrapper's COMPOSITIONAL
 *  richness keeps it non-rich, matching the top-level grid; see the BLOCKQUOTE / list
 *  branches.)
 *
 *  Visible content is TEXT — measured through `skipTagsText` (SKIP_TAGS excluded) and
 *  the full-strip `blankAfterInvisible`, so neither whitespace, the zero-width class,
 *  nor `<style>`/`<textarea>` text counts — OR an `<hr>`, and `<hr>` ONLY. That second
 *  clause is not a tag list creeping in through the back door: an `<hr>` is the one
 *  text-free element whose OWN branch depends on this predicate to survive — a
 *  text-free `<table>` also renders something a reader sees, but its branch emits
 *  unconditionally and consults the predicate only via a container wrapper, so it
 *  needs no clause here. The other text-free elements stay out on purpose, each for
 *  its own reason: an `<img>` renders in a browser but serialises to NOTHING here, so
 *  counting it would push an empty wrapper; and a lone `<br>` IS the emptied-block
 *  residue this guard exists to reject.
 *
 *  Without that clause a container whose only child is an `<hr>` —
 *  `<blockquote><hr></blockquote>`, `<li><hr></li>` — read as empty and was dropped
 *  outright. That is content LOSS, the opposite failure from the rest of this
 *  guard, and for an HTML-only clipboard nothing downstream carries the rule.
 *
 *  `querySelector`, not `getElementsByTagName`: a static single-element lookup, not
 *  one of the live collections this module avoids (header design notes). It is
 *  evaluated only when the text test already said "no". */
function hasVisibleContent(el: Element): boolean {
  // TEXT term through `skipTagsText` (so `<style>`/`<textarea>` text no reader sees is
  // excluded) + `blankAfterInvisible` (full-strip: `trim()` alone strips U+00A0 but not
  // the zero-width class, so a contenteditable's emptied block `<h1>&#8203;</h1>` or a
  // lone joiner `<h1>&#8205;</h1>` would read as content). The `<hr>` clause is
  // UNCHANGED — it is what keeps `<blockquote><hr>` / `<li><hr>` emitting `---`.
  return !blankAfterInvisible(skipTagsText(el)) || el.querySelector("hr") !== null;
}

/** Direct element children of `el` whose tagName is `tag`. */
function directChildrenByTag(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}

/** Language token from a <pre>'s <code class="language-xxx"> (or `lang-xxx`),
 *  sanitised: accepted only when it is a single run of word / `+#.-` chars. */
function codeLang(pre: Element): string {
  const code = directChildrenByTag(pre, "CODE")[0] ?? pre;
  const m = /(?:language|lang)-(\S+)/.exec(code.getAttribute("class") ?? "");
  const raw = m ? m[1] : "";
  return /^[\w+#.-]+$/.test(raw) ? raw : "";
}

/** Collect direct list items after validating content that would otherwise be lost. */
function collectList(list: Element, depth: number, ctx: Ctx): BlockNode {
  if (depth > MAX_DEPTH) {
    throw new CapExceeded();
  }
  for (const child of Array.from(list.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      if (!blankAfterInvisible(child.textContent ?? "")) {
        throw new CapExceeded();
      }
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) {
      continue; // comment / PI carries nothing
    }
    const el = child as Element;
    if (el.tagName !== "LI" && !SKIP_TAGS.has(el.tagName) && hasVisibleContent(el)) {
      throw new CapExceeded();
    }
  }
  const ordered = list.tagName === "OL";
  let n = ordered ? Number.parseInt(list.getAttribute("start") ?? "1", 10) : 0;
  // Clamp `start` into the ListMark-recognisable range [0, MAX_LIST_NUMBER] (the
  // same bound `orderedShape` enforces): a negative value would emit `-3.` — not a
  // list marker, so the item degrades to a paragraph — and a 10+-digit ordinal
  // breaks @lezer/markdown's ListMark recognition. A malformed `start` (NaN) falls
  // back to 1. The per-item marker below re-clamps so a start near the ceiling can
  // never increment past it either.
  if (!Number.isFinite(n)) {
    n = 1;
  } else {
    n = Math.min(Math.max(n, 0), MAX_LIST_NUMBER);
  }
  const items: (readonly BlockNode[])[] = [];
  for (const li of directChildrenByTag(list, "LI")) {
    bump(ctx);
    if (hasVisibleContent(li)) {
      items.push(collectBlocks(li, depth + 1, ctx));
    }
  }
  return {
    kind: "list",
    ordered,
    start: n,
    items,
    hasOwnText: !blankAfterInvisible(skipTagsText(list)),
  };
}

function isBr(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE && (node as Element).tagName === "BR";
}

/** A text node holding nothing visible — whitespace or the zero-width class,
 *  decided by the SAME full-strip rule as every other emptiness check. Transparent
 *  inside a `<br>` run — real clipboard HTML pretty-prints `<br>\n<br>`, and that
 *  newline (or a stray zero-width byte) must not break the run into two single
 *  breaks. */
function isBlankText(node: Node): boolean {
  return node.nodeType === TEXT_NODE && blankAfterInvisible(node.textContent ?? "");
}

/** Split sibling inline nodes at runs of 2+ `<br>` — HTML's idiom for a blank
 *  line, i.e. a BLOCK separator rather than two hard breaks (which rendered as a
 *  line holding nothing but the escaping backslash). Splitting the NODE list
 *  rather than the serialised string is what keeps a `<br>` nested inside an
 *  emphasis span invisible here: it belongs to that span's inline content, and a
 *  string-level split would tear `**foo` from `bar**`. Single breaks stay in
 *  their segment and remain hard breaks. Linear in the node count. */
function splitInlineSegments(nodes: Node[]): Node[][] {
  const segments: Node[][] = [];
  let current: Node[] = [];
  // Pending holds a candidate run — the `<br>`s AND any whitespace-only text
  // between them, in document order. Whitespace is buffered rather than dropped
  // on sight: if the run turns out to be a LONE break it stays inline, and its
  // neighbouring whitespace must go back into the segment with it (dropping it
  // would silently eat a space that the old code emitted).
  let pending: Node[] = [];
  let breaks = 0;
  const settlePendingBreaks = (): void => {
    if (breaks >= 2) {
      segments.push(current); // 2+ breaks: end this block, drop the whole run
      current = [];
    } else {
      current.push(...pending); // a lone break (plus its whitespace) stays inline
    }
    pending = [];
    breaks = 0;
  };
  for (const node of nodes) {
    if (isBr(node)) {
      pending.push(node);
      breaks++;
    } else if (breaks > 0 && isBlankText(node)) {
      pending.push(node); // whitespace inside a run — buffered, not dropped
    } else {
      settlePendingBreaks();
      current.push(node);
    }
  }
  settlePendingBreaks();
  segments.push(current);
  return segments;
}

/** Nodes that serialise to nothing, dropped BEFORE segmentation: comments / PIs
 *  and `SKIP_TAGS` subtrees. Without this the two callers of
 *  `splitInlineSegments` see different node universes — `collectBlocks`'
 *  inline-run path already `continue`s on both, but the `<p>` branch passes raw
 *  `childNodes` — so `<p>a<br><!--x--><br>b</p>` split into two hard breaks while
 *  the same markup at top level split into blocks. Word / Outlook clipboard HTML
 *  puts conditional comments (`<!--[if !supportLists]-->`) between breaks inside
 *  paragraphs, which is exactly this shape.
 *
 *  Known gap, deliberately not closed here: an EMPTY INLINE ELEMENT
 *  (`a<br><span></span><br>b`) still INTERRUPTS the `<br>` run, so the two breaks
 *  are never seen as the 2+ run that would split the block. They settle as two
 *  lone hard breaks in ONE paragraph — i.e. a line holding nothing but the
 *  escaping backslash, the artefact the neighbouring comments describe, not an
 *  extra block. It does so on BOTH callers — a shared limitation, not the caller
 *  asymmetry above. Recognising it needs a serialise-then-test pass rather than a
 *  node filter. */
function contributesNothing(node: Node): boolean {
  if (node.nodeType === TEXT_NODE) {
    return false;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return true; // comment / PI / CDATA
  }
  return SKIP_TAGS.has((node as Element).tagName);
}

function collectParagraphs(nodes: Node[], depth: number, ctx: Ctx): BlockNode[] {
  const blocks: BlockNode[] = [];
  for (const segment of splitInlineSegments(nodes.filter((node) => !contributesNothing(node)))) {
    const inline = inlineMarkdown(segment, depth, ctx, "paragraph");
    const markdown = escapeMarkers(inline.markdown).trim();
    if (markdown !== "") {
      blocks.push({ kind: "paragraph", inline: { markdown, rich: inline.rich } });
    }
  }
  return blocks;
}

/** Collect block children without mutating the parsed DOM. */
function collectBlocks(parent: Element, depth: number, ctx: Ctx): readonly BlockNode[] {
  if (depth > MAX_DEPTH) {
    throw new CapExceeded();
  }
  const blocks: BlockNode[] = [];
  let inlineRun: Node[] = [];
  const flushInline = (): void => {
    if (inlineRun.length > 0) {
      blocks.push(...collectParagraphs(inlineRun, depth, ctx));
      inlineRun = [];
    }
  };
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      inlineRun.push(child);
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) {
      continue;
    }
    const el = child as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) {
      continue;
    }
    bump(ctx);
    if (HEADINGS[tag]) {
      flushInline();
      if (hasVisibleContent(el)) {
        const inline = inlineMarkdown(Array.from(el.childNodes), depth, ctx, "heading");
        const markdown = collapseWs(inline.markdown).trim();
        if (!blankAfterInvisible(markdown)) {
          blocks.push({
            kind: "heading",
            level: HEADINGS[tag],
            inline: { markdown, rich: inline.rich },
          });
        }
      }
    } else if (tag === "P") {
      flushInline();
      blocks.push(...collectParagraphs(Array.from(el.childNodes), depth, ctx));
    } else if (tag === "UL" || tag === "OL" || tag === "MENU") {
      flushInline();
      blocks.push(collectList(el, depth, ctx));
    } else if (tag === "PRE") {
      flushInline();
      if (hasVisibleContent(el)) {
        const body = skipTagsText(el).replace(/\n$/, "");
        if (!blankAfterInvisible(body)) {
          const lang = codeLang(el);
          count(ctx, fenceCode(body, lang));
          blocks.push({ kind: "code", body, lang });
        }
      }
    } else if (tag === "BLOCKQUOTE") {
      flushInline();
      if (hasVisibleContent(el)) {
        blocks.push({
          kind: "quote",
          children: collectBlocks(el, depth + 1, ctx),
          hasOwnText: !blankAfterInvisible(skipTagsText(el)),
        });
      }
    } else if (tag === "TABLE") {
      flushInline();
      const gfm = tableElementToGfm(el);
      if (gfm === null) {
        throw new CapExceeded();
      }
      count(ctx, gfm);
      const visible = Array.from(el.querySelectorAll("td, th, caption")).some(
        (cell) => !blankAfterInvisible(skipTagsText(cell))
      );
      blocks.push({ kind: "table", gfm, content: visible ? "visible" : "empty" });
    } else if (tag === "HR") {
      flushInline();
      blocks.push({ kind: "rule" });
    } else if (tag === "BR") {
      inlineRun.push(el);
    } else {
      const startsOwnBlock =
        BLOCK_LEVEL_TAGS.has(tag) ||
        Array.from(el.children).some((c) => BLOCK_LEVEL_TAGS.has(c.tagName));
      if (startsOwnBlock) {
        flushInline();
        blocks.push(...collectBlocks(el, depth + 1, ctx));
      } else {
        inlineRun.push(el);
      }
    }
  }
  flushInline();
  return blocks;
}

/** Result of converting a clipboard `text/html` fragment.
 *
 *  `emittedMarkdownSyntax` is false when the walk produced escaped text and line
 *  structure only — no emphasis / link / code / heading / list / quote / table /
 *  rule. It does NOT mean the HTML flavour was redundant: line structure (a
 *  `<br>` hard break, `<div>`-per-line blocking) is information only that flavour
 *  carries, and the caller's defer trades it away — deliberately, because escaped
 *  output would corrupt Markdown the user typed by hand, and because producers in
 *  practice mirror their block structure into `text/plain`. See the defer site in
 *  rich-html-paste.ts. */
export interface HtmlToMarkdownResult {
  /** NEVER the empty string — `htmlToMarkdown` returns `null` instead. The
   *  consumer relies on this: it dispatches `markdown` (inline, or framed by
   *  `blockPrefix` / `blockSuffix`) AFTER calling preventDefault(), so an empty
   *  `markdown` would replace a non-empty selection with nothing or with blank-line
   *  separators alone — a silent deletion.
   *  Keep the `out === ""` early return in place. */
  readonly markdown: string;
  readonly emittedMarkdownSyntax: boolean;
}

export function htmlToMarkdown(html: string): HtmlToMarkdownResult | null {
  if (html.length > MAX_HTML_INPUT_CHARS) {
    return null; // expected degradation for oversized input — silent, like CapExceeded
  }
  let body: Element | null;
  try {
    body = new DOMParser().parseFromString(html, "text/html").body;
  } catch (err) {
    // Same policy as the walk's catch at the bottom, applied here because the two
    // returns are indistinguishable to the caller: on a clipboard where the paste
    // would be dropped, `null` makes rich-html-paste.ts log "unconvertible HTML-only
    // clipboard dropped", which pins the blame on what the user copied — and on an
    // ordinary clipboard, one that carries a `text/plain` flavour to defer into, it
    // logs nothing at all and this warn is the ONLY trace. Either way the trace has
    // to be left here. DOMParser is a platform global and `text/html` parsing does
    // not throw on malformed input, so a throw here is an environment/converter
    // fault and must leave its own trace. Error only — never the HTML, which is
    // clipboard content and can be anything the user copied.
    console.warn("[quoll] rich paste: HTML parse failed", err);
    return null;
  }
  if (!body) {
    console.warn("[quoll] rich paste: parsed HTML document has no body");
    return null;
  }
  try {
    const ctx: Ctx = {
      nodes: 0,
      outLen: 0,
      repair: { remaining: MAX_REPAIR_WORK },
    };
    const result = serializeBlockNodes(collectBlocks(body, 0, ctx));
    const out = result.markdown.trim();
    // The incremental `count` cap already aborts amplification mid-build; this
    // final check is a cheap backstop against uncounted wrapper growth (list /
    // blockquote indentation).
    if (out === "" || out.length > MAX_OUTPUT_CHARS) {
      return null;
    }
    return { markdown: out, emittedMarkdownSyntax: result.rich };
  } catch (err) {
    // ANY error still degrades to `null` — the caller always has a safe path. But
    // `null` is no longer only a defer: rich-html-paste.ts CONSUMES it to protect a
    // selection, so an unexpected throw in this walk would present to the user as
    // "the paste did nothing" and leave no trace anywhere. Split the two:
    // CapExceeded is the EXPECTED degradation (input too large / deep / wide, an
    // unrenderable table, or a list with a non-`<li>` direct child — element or text
    // node — carrying visible content) and stays silent; anything else is a bug here and gets a
    // console entry, as image-paste.ts already does for its own dropped inputs.
    //
    // Log the error ONLY. The source HTML and the converted Markdown must never be
    // logged: that is clipboard content, which can be anything the user copied —
    // credentials, private documents — whereas an internal error's text is ours.
    // The emphasis repair cap is a CapExceeded (same fallback) but trips only on
    // pathological input, so it is the one cap that says so — without the error or
    // any content.
    if (err instanceof InlineRepairCapExceeded) {
      console.warn("[quoll] rich paste: emphasis repair cap exceeded");
    } else if (!(err instanceof CapExceeded)) {
      console.warn("[quoll] rich paste: HTML→Markdown conversion failed", err);
    }
    return null;
  }
}
