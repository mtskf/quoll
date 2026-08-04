// Pure converter: an HTML `text/html` clipboard fragment → `{ markdown,
// emittedMarkdownSyntax }`, or `null` when there is nothing convertible. No
// dependency, no side effects — `DOMParser` is a webview/browser global
// (happy-dom provides it under test), so this stays inside Quoll's supply-chain
// default-deny.
//
// TWO output channels, both of which INVITE the caller to prefer the clipboard's
// own bytes. Neither commands it — what the caller does depends on what else the
// clipboard carries, so do not assume either output string is unreachable:
//  - `null` — nothing convertible (empty walk, cap breached, parse error). The
//    caller normally defers, but when NOTHING can absorb the defer — no plain/uri
//    fallback, no image file item for imagePaste — over a non-empty selection it
//    SWALLOWS the event instead (deferring would let CM's `doPaste("")` delete the
//    selection) — no paste of any kind happens.
//  - `emittedMarkdownSyntax === false` — the walk produced escaped text and line
//    structure only. The conversion is valid Markdown, but the caller prefers the
//    clipboard's own `text/plain` bytes over this module's escaped rendering — or
//    lets imagePaste have the event when an image file rides along. Only when
//    NEITHER exists does it insert this module's output after all, so the escaped
//    rendering is a live path, not dead code.
//    This is the dominant path for clipboards that carry a merely presentational
//    HTML flavour. See the `HtmlToMarkdownResult` docblock at the bottom.
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
//    hand would come back as `\- \[ \]` — which is why the caller defers on
//    `emittedMarkdownSyntax === false`. On an ordinary clipboard, one carrying a
//    safe plain fallback, that defer inserts the clipboard's own bytes verbatim,
//    exactly as typing them would. It is NOT unconditional: when nothing downstream
//    can absorb the defer (an HTML-only clipboard) the caller inserts this escaped
//    rendering after all, because the alternative is a paste that does nothing.
//  - Whether a container is visually EMPTY is decided by ONE rule —
//    `blankAfterInvisible` (full-strip zero-width + whitespace), measured over
//    SKIP_TAGS-filtered text (`skipTagsText`) — never re-derived from a branch's own
//    rendered output, which is what six separate branches got wrong (an empty list
//    renders `-`, not ``). Most branches reach that rule through `hasVisibleContent(el)`,
//    which wraps it and adds the `<hr>` clause: every container branch that sets
//    `emittedMarkdownSyntax` routes through `hasVisibleContent` — on that container, or
//    (for `<ul>`/`<ol>`) on each `<li>`. Three branches set their flag WITHOUT calling
//    `hasVisibleContent(el)`, each for its own reason — and only TWO of them decide
//    emptiness by the same `blankAfterInvisible` rule; the third (`<hr>`) opts out of
//    the emptiness question entirely. Do not assume otherwise when changing them:
//     · `<hr>` opts out of the rule entirely. A void element: the predicate would
//       answer "empty" for every one, and thematic breaks would stop converting.
//     · `<table>` emits its grid unconditionally and takes its RICHNESS from a PER-CELL
//       `blankAfterInvisible(skipTagsText(cell))` check (td/th/caption), NOT from
//       `hasVisibleContent(el)` — whose `<hr>` clause would call an `<hr>`-only spacer
//       cell rich. The one branch where "emit this" and "this is rich" differ.
//     · `<strong>`/`<b>`/`<em>`/`<i>` set their flag in `emphasize`, which consults
//       `blankAfterInvisible` on the emitted `inner` — HARD_BREAK folded to a space
//       first, so neither a lone-joiner nor a joiner-plus-`<br>` span is bolded — but
//       never calls `hasVisibleContent(el)`. `wrapEmphasis` additionally hoists
//       spaces/`<br>` edges out of the markers.
//    A block pushed with `syntax: false` — a paragraph, or the blocks a nested
//    walk already recorded for itself — needs none of this: it cannot flip the
//    flag, so its own "did anything render" test cannot defeat the caller's defer.
//  - Never throws to the handler: caps throw an internal sentinel (`CapExceeded`);
//    `htmlToMarkdown` wraps the whole walk in a try/catch that returns `null` for
//    ANY thrown value, so the handler always has a safe defer-to-plain-paste path.

import { isAllowedUrl } from "../../../markdown/url-allowlist.js";
import { MAX_LIST_NUMBER } from "../list/list-transform.js";
import { SKIP_TAGS, tableElementToGfm } from "./html-table-to-gfm.js";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const MAX_HTML_INPUT_CHARS = 2 * 1024 * 1024; // 2 MiB source HTML
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024; // bound total emitted Markdown (checked incrementally)
const MAX_NODES = 50_000; // total element visits
// Recursion depth cap for BOTH inline and block walks. 32 is far beyond any real
// document (nobody nests 32 blockquotes/lists or 32 inline emphasis spans), yet
// low enough that the transient peak memory of wrapper re-indentation
// (`prefixLines` / `indentContinuation` rebuild a copy of the child body at each
// level) is bounded to `MAX_DEPTH × MAX_OUTPUT_CHARS` and then freed. A deeper
// fragment throws CapExceeded → `null` → plain-text paste (which handles the same
// bytes linearly). This is the guard against both call-stack exhaustion and
// wrapper-amplification memory blow-up.
const MAX_DEPTH = 32;

// `SKIP_TAGS` is imported from html-table-to-gfm.ts (single source of truth,
// shared because the rich converter reuses tableElementToGfm) — SCRIPT/STYLE/…
// plus form-control + embed elements whose text/value is not prose.

/** Internal cap sentinel — thrown deep in the walk, caught by `htmlToMarkdown`,
 *  which returns `null` so the handler degrades to plain-text paste. NEVER
 *  propagates to the DOM event handler. */
class CapExceeded extends Error {}

interface Ctx {
  nodes: number; // element visits
  outLen: number; // cumulative emitted Markdown length (incremental output cap)
  // Did the walk emit Markdown SYNTAX (as opposed to escaped text + line
  // structure)? Recorded at the emitting site rather than sniffed from the
  // output string, because escaped text can legitimately contain any marker
  // byte. The handler uses it to choose between this conversion and the
  // clipboard's own `text/plain` bytes. Block-level writes go through
  // `serializeBlocks`' `push`, which takes the fact as a REQUIRED argument;
  // only the inline leaves below assign it directly.
  emittedMarkdownSyntax: boolean;
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
 *  Deletes ONLY the width-less SPACING class — U+200B ZERO WIDTH SPACE, U+2060 WORD
 *  JOINER, U+FEFF — because these occupy no width, so folding one into a space would
 *  insert a gap between two letters that touch. U+200C ZERO WIDTH NON-JOINER and
 *  U+200D ZERO WIDTH JOINER are DELIBERATELY PRESERVED here: they are also width-less
 *  but they carry meaning — U+200D glues emoji ZWJ sequences (a family / profession /
 *  flag emoji), U+200C is required orthography in Persian and Indic scripts — so
 *  deleting them on the emit path corrupts real text on disk (a family emoji splits
 *  into three people; a Persian word loses a letter). This runs on EVERY emitted text
 *  node, so it is fidelity-first. U+00A0 needs no clause — it IS `\s`.
 *
 *  EMPTINESS is a SEPARATE question, answered by `blankAfterInvisible`, which strips
 *  the FULL zero-width class (joiners included) because a lone joiner is visually
 *  empty even though a joiner WITHIN text is load-bearing. Splitting the two is what
 *  lets output keep joiners while `hasVisibleContent` still rejects a contenteditable's
 *  emptied block — the leftover container (`<h1>&#8203;</h1>`, `<h1>&#8205;</h1>`) the
 *  emptiness guard exists to reject, which `String.prototype.trim()` does not strip. */
function collapseWs(text: string): string {
  return text.replace(/[\u200B\u2060\uFEFF]/g, "").replace(/\s+/g, " ");
}

/** Emptiness normaliser: strip the FULL zero-width class plus the invisible/ignorable
 *  formatting chars in the regex below (U+00AD SOFT HYPHEN, the joiners, U+FE00–FE0F
 *  VARIATION SELECTORs, U+2060 WORD JOINER, U+FEFF), collapse whitespace, trim, and
 *  report whether nothing visible remains. Distinct from `collapseWs` (the emit path,
 *  which PRESERVES joiners and variation selectors for fidelity): a lone one reads as
 *  blank here so an otherwise-empty container holding only one cannot flip
 *  `emittedMarkdownSyntax`. THE single answer to "is this text visually empty" — routed
 *  through by every emptiness decision in this module: `hasVisibleContent`, the table
 *  per-cell richness check, `emphasize`'s gate, the CODE/A/PRE/heading residue guards,
 *  and the inline-run blank-text / non-`<li>` list-child checks — so none grows its own
 *  rule. */
function blankAfterInvisible(text: string): boolean {
  return (
    text
      // Invisible / ignorable formatting chars stripped by the Unicode
      // Default_Ignorable_Code_Point PROPERTY, not a hand-enumerated list: one bounded,
      // self-updating class covers the zero-width joiners (ZWSP/ZWNJ/ZWJ/WJ/BOM), U+00AD
      // SOFT HYPHEN, the U+FE00–FE0F VARIATION SELECTORs, the bidi marks/isolates
      // (LRM/RLM/ALM, U+2066–2069) and any future format char — every char that reads
      // as blank. It matches NONE of letter/space/NBSP/heart/emoji/hyphen/CJK. This is the
      // EMPTINESS path ONLY; `collapseWs` (the OUTPUT path) must NOT strip these — VS16 is
      // load-bearing in emoji presentation (`❤️` = U+2764 U+FE0F), joiners glue
      // emoji/orthography, and the bidi marks order real mixed-direction text.
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
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
 *  `textContent` rather than `serializeInline` — `<pre>` (verbatim) and inline `<code>`
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
 *  that cannot terminate early. Angle-bracket form tolerates spaces and parens
 *  but not `<`/`>`/newlines; bare form is used when the URL has none of
 *  ` ()<>`; otherwise `<`/`>` are percent-encoded and the safest form chosen.
 *  Newlines are stripped (isAllowedUrl already rejects control bytes; belt-and-
 *  braces). */
function markdownDestination(url: string): string {
  const clean = url.replace(/[\r\n]/g, "");
  if (!/[\s()<>]/.test(clean)) {
    return clean; // bare-safe
  }
  if (!/[<>]/.test(clean)) {
    return `<${clean}>`; // angle form tolerates spaces + parens
  }
  const enc = clean.replace(/</g, "%3C").replace(/>/g, "%3E");
  return /[\s()]/.test(enc) ? `<${enc}>` : enc;
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

/** Wrap `inner` in an emphasis `marker` (`**`/`*`) with edge whitespace HOISTED
 *  outside the markers: CommonMark flanking rules reject a delimiter run adjacent
 *  to whitespace, so `<strong>foo </strong>` must emit `**foo** ` — never
 *  `**foo **`, whose closing run is space-preceded and shows as literal `**`. The
 *  hoisted edge run is spaces (collapsed to single spaces by `collapseWs`) AND
 *  `<br>` hard-break tokens (`\` + `\n`), each taken as ONE unit so its escaping
 *  backslash is never separated from its newline: a whitespace-class match (`\s`)
 *  would consume only the `\n` and strand the `\` at the boundary, emitting a
 *  marker-escaping `**foo\**`. When the whole span is hoistable (spaces/`<br>`s
 *  only) the core is empty and `inner` is returned unwrapped — a `<br>`-only span
 *  like `<strong><br></strong>` yields a bare hard break, not an empty `**\\\n**`.
 *  Done with two linear index scans, NOT a regex: an `^edge*? core edge*$` pattern
 *  backtracks O(n²) on a long `<br>` run fenced by non-hoistable text on both
 *  sides. Wrapping is O(1)/uncounted — `inner`'s leaves were already counted. */
function wrapEmphasis(inner: string, marker: string): string {
  let start = 0;
  while (start < inner.length) {
    if (inner[start] === " ") {
      start += 1;
    } else if (inner[start] === "\\" && inner[start + 1] === "\n") {
      start += 2; // a `<br>` hard-break token — hoisted whole
    } else {
      break;
    }
  }
  let end = inner.length;
  while (end > start) {
    if (inner[end - 1] === " ") {
      end -= 1;
    } else if (inner[end - 1] === "\n" && inner[end - 2] === "\\") {
      end -= 2;
    } else {
      break;
    }
  }
  if (start >= end) {
    return inner; // all-whitespace / `<br>`-only: nothing to wrap
  }
  return `${inner.slice(0, start)}${marker}${inner.slice(start, end)}${marker}${inner.slice(end)}`;
}

/** `wrapEmphasis`, recording on `ctx` whether markers were actually emitted.
 *  `wrapEmphasis` returns its input unchanged when the span is all-whitespace /
 *  `<br>`-only, and that degenerate case emits no syntax — so compare rather than
 *  assume. Wrapping and recording are one call so they cannot be given different
 *  inputs.
 *
 *  This is where emphasis consults the emptiness rule: emphasis does NOT route
 *  through `hasVisibleContent(el)`, but a VISUALLY EMPTY span must still not become
 *  `**…**` and flip the flag. `wrapEmphasis` already returns `inner` for a
 *  whitespace-/`<br>`-only span, but the emit path preserves joiners, so a lone-joiner
 *  span (`<strong>&#8205;</strong>`) — or a joiner-plus-`<br>` span, once the HARD_BREAK
 *  token is folded to a space (see the body) — reaches here with non-hoistable `inner`.
 *  `blankAfterInvisible` (the same full-strip predicate the containers use) rejects it,
 *  returning `inner` transparently — like a `<span>` — with no markers and no flag,
 *  while a joiner WITHIN visible text (`<strong>👨‍👩‍👧</strong>`) still bolds. */
function emphasize(ctx: Ctx, inner: string, marker: string): string {
  // Fold HARD_BREAK tokens to a space before the emptiness gate, the same
  // whole-token fold the `<a>` label uses. A `<br>` contributes no bold content
  // (like whitespace / the zero-width class), but its token's escaping `\` survives
  // `blankAfterInvisible`'s full-strip + trim — so a span of only a joiner + `<br>`
  // (`<strong>&#8205;<br></strong>`) would otherwise pass the gate and wrap the
  // residual joiner into `**‍**`, flipping the flag.
  if (blankAfterInvisible(inner.split(HARD_BREAK).join(" "))) {
    return inner;
  }
  const wrapped = wrapEmphasis(inner, marker);
  if (wrapped !== inner) {
    ctx.emittedMarkdownSyntax = true;
  }
  return wrapped;
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

/** The hard-break token `serializeInline` emits for `<br>`: a backslash
 *  immediately followed by a newline. Declared here, above its emitting site, so
 *  that site, the `trimSegmentEdges` scan and the `<a>` label fold all read the
 *  same token and cannot drift apart.
 *
 *  ⚠️ ONE place matches the same two characters WITHOUT referencing this constant:
 *  `wrapEmphasis`, declared above it, whose edge-hoisting scans compare `"\\"` and
 *  `"\n"` index by index. Change the token here and you must change those scans
 *  too — the anti-drift guarantee this declaration site offers covers its three
 *  referencing sites only, by convention, not by anything the compiler enforces.
 *
 *  A `\n` in an inline fragment ALWAYS comes from a `<br>` and always carries its
 *  own leading backslash, so matching the two-character token is unambiguous.
 *  That holds because EVERY text node on the inline path goes through
 *  `collapseWs`, which turns each whitespace run into a single space. Note the
 *  reason is `collapseWs`, NOT "`<pre>` is handled elsewhere": only DIRECT
 *  children are block-tested, so a `<pre>` under an inline ancestor
 *  (`<em><span><pre>a\nb</pre></span></em>`) does reach `serializeInline` — its
 *  body simply arrives as a text node and loses its newlines like any other. Do
 *  not skip `collapseWs` anywhere on the inline path on the assumption that
 *  `<pre>` cannot appear there. */
const HARD_BREAK = "\\\n";

/** Serialise inline content (children of a block) to a Markdown fragment. Text is
 *  whitespace-collapsed + escaped; recognised inline elements wrap their
 *  serialised children; unknown inline elements recurse transparently. `depth`
 *  guards against call-stack exhaustion on pathological nesting. */
function serializeInline(node: Node, depth: number, ctx: Ctx): string {
  if (depth > MAX_DEPTH) {
    throw new CapExceeded();
  }
  if (node.nodeType === TEXT_NODE) {
    return count(ctx, escapeInline(collapseWs(node.textContent ?? "")));
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return "";
  }
  const el = node as Element;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) {
    return "";
  }
  bump(ctx);
  if (tag === "BR") {
    return count(ctx, HARD_BREAK); // hard break (backslash form survives trimming)
  }
  if (tag === "CODE") {
    // Inline <code> (a <code> child of <pre> is handled by the block path). An
    // EMPTY one renders as the two-backtick `` — non-empty output from a container
    // holding nothing. Body is read through `skipTagsText` so a `<style>`/`<textarea>`
    // beside the code contributes nothing, then `collapseWs` (emit path) collapses it.
    const body = collapseWs(skipTagsText(el));
    // Both terms load-bearing, and both KEPT:
    //  - `!hasVisibleContent(el)` is the full-strip emptiness gate. `body` is
    //    collapseWs'd (emit path), which PRESERVES joiners, so a lone-joiner
    //    `<code>&#8205;</code>` survives into `body`; only the predicate rejects it.
    //  - `blankAfterInvisible(body)` is the residue: when the predicate passes on its
    //    `<hr>` clause (`<code> <hr> </code>`) the body is whitespace with nothing to
    //    fence. The SAME full-strip rule, not `.trim()` — the emit-path collapse leaves
    //    a joiner (`<code><hr>&#8205;</code>`) that `.trim()` would let through.
    if (!hasVisibleContent(el) || blankAfterInvisible(body)) {
      return "";
    }
    ctx.emittedMarkdownSyntax = true;
    return count(ctx, inlineCode(body));
  }
  const inner = serializeChildrenInline(el, depth + 1, ctx); // leaves counted within
  switch (tag) {
    // A tag whose own style cancels it is transparent, exactly like an unknown
    // inline element: no markers, no flag. See styleCancelsEmphasis.
    case "STRONG":
    case "B":
      return styleCancelsEmphasis(el, "font-weight") ? inner : emphasize(ctx, inner, "**");
    case "EM":
    case "I":
      return styleCancelsEmphasis(el, "font-style") ? inner : emphasize(ctx, inner, "*");
    case "A": {
      const href = el.getAttribute("href") ?? "";
      // Link text on one line (a newline in the label would break the link). Fold
      // the whole HARD_BREAK token, not just its `\n`: dropping the newline alone
      // strands the escaping backslash mid-label (`[a\ b](…)`), and a backslash
      // before a space is not a CommonMark escape — it renders literally. Same
      // token-as-one-unit rule as trimSegmentEdges and wrapEmphasis. The second
      // sweep has nothing left to find while the HARD_BREAK docblock's invariant
      // holds (every inline `\n` arrives as part of the token); it stays as the
      // unconditional guarantee that no newline can reach a link label.
      const label = inner.split(HARD_BREAK).join(" ").replace(/\n/g, " ");
      // Only the wrapping syntax is uncounted (O(1)); the label leaves are counted.
      if (!isAllowedUrl(href)) {
        return label; // rejected destination → bare label, no syntax emitted
      }
      // An EMPTY <a> renders as `[](url)` — a link the reader cannot see or click,
      // and non-empty output from a container holding nothing. The commonest source
      // is a marketing mail's tracking pixel (`<a href="…"><img src="p.gif"></a>`),
      // which rides along beside otherwise plain text. Same treatment as the other
      // empty containers: label only (here, the empty string), no syntax flag.
      //
      // Both terms load-bearing: `!hasVisibleContent(el)` is the full-strip emptiness
      // gate (SKIP_TAGS-aware — `label` from serializeChildrenInline already drops
      // SKIP_TAGS, but the predicate is what rejects a lone joiner or a whitespace-only
      // label the emit path preserved); `blankAfterInvisible(label)` is the residue for
      // when the predicate passes on its `<hr>` clause (`<a href> <hr> </a>`) and the
      // label has nothing to link. The SAME full-strip rule, not `.trim()` — a joiner
      // label (`<a href><hr>&#8205;</a>`) that `.trim()` would leave non-empty reads as
      // blank here, so no link is emitted.
      if (!hasVisibleContent(el) || blankAfterInvisible(label)) {
        return label;
      }
      ctx.emittedMarkdownSyntax = true;
      return `[${label}](${markdownDestination(href)})`;
    }
    default:
      return inner; // span/font/unknown inline → transparent
  }
}

function serializeChildrenInline(el: Element, depth: number, ctx: Ctx): string {
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    out += serializeInline(child, depth, ctx);
  }
  return out;
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
  // Block-level but normally consumed by its parent handler: `serializeList`
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
 *  close. See the TABLE branch comment for the per-cell richness rule.
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

/** A rendered block that starts with a list marker (our own output shape) — used
 *  to join list-item continuation blocks tightly (no blank line) vs loose. */
function isListBlock(block: string): boolean {
  return /^(?:[-*+]|\d{1,9}[.)])\s/.test(block);
}

/** Indent every non-blank line of `block` by `indent`; blank lines stay empty. */
function indentContinuation(block: string, indent: string): string {
  return block
    .split("\n")
    .map((l) => (l === "" ? "" : indent + l))
    .join("\n");
}

/** Prefix every line with `prefix`; a blank line becomes the trimmed prefix (so a
 *  blockquote's paragraph gap renders as `>`). */
function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? prefix.trimEnd() : prefix + l))
    .join("\n");
}

/** Fence a <pre> code block: a backtick run one longer than the longest run in
 *  the body, min length 3. Body is literal. `lang` is sanitised to a single safe
 *  info-string token (empty when malformed) so it cannot break the fence. */
function fenceCode(body: string, lang: string): string {
  const longest = longestBacktickRun(body);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** Language token from a <pre>'s <code class="language-xxx"> (or `lang-xxx`),
 *  sanitised: accepted only when it is a single run of word / `+#.-` chars. */
function codeLang(pre: Element): string {
  const code = directChildrenByTag(pre, "CODE")[0] ?? pre;
  const m = /(?:language|lang)-(\S+)/.exec(code.getAttribute("class") ?? "");
  const raw = m ? m[1] : "";
  return /^[\w+#.-]+$/.test(raw) ? raw : "";
}

/** Serialise one `<li>`: render its children as blocks (so nested lists, `<p>`,
 *  `<pre>`, `<blockquote>` are structured, not flattened), then prefix the first
 *  block with `marker` and indent continuation blocks by the marker width — a
 *  blank line before loose (paragraph) continuations, none before a nested list. */
function serializeListItem(li: Element, marker: string, depth: number, ctx: Ctx): string {
  const blocks = serializeBlocks(li, depth + 1, ctx);
  const indent = " ".repeat(marker.length);
  if (
    blocks.length === 0 ||
    blocks.every((b) => blankAfterInvisible(b.split(HARD_BREAK).join(" ")))
  ) {
    // No marker for an item whose blocks are all visually empty. `serializeList` has
    // already refused the empty <li>s via hasVisibleContent, so what reaches here is an
    // item whose blocks serialised to nothing readable — text living entirely in a
    // SKIP_TAGS subtree (`<li><style>…</style></li>`, → no blocks), or a lone joiner left
    // by a buried <hr> that satisfied the predicate's <hr> clause but serialised away
    // (`<li><span><span><hr></span></span>‍</li>`). A different question (did
    // serialisation keep anything readable?) than the one hasVisibleContent answers, on
    // the SAME full-strip `blankAfterInvisible` rule as the HEADINGS/PRE/blockquote
    // residues. Returning `marker` here is what emitted the bare `-` that made an empty
    // bullet look like rich content; `serializeList`'s `item === ""` skip then drops it
    // WITHOUT advancing the ordinal.
    return "";
  }
  const first = blocks[0]
    .split("\n")
    .map((l, i) => (i === 0 ? marker + l : l === "" ? "" : indent + l))
    .join("\n");
  let out = first;
  for (const b of blocks.slice(1)) {
    out += (isListBlock(b) ? "\n" : "\n\n") + indentContinuation(b, indent);
  }
  return out;
}

/** Serialise a `<ul>`/`<ol>` at nesting `depth`; items joined tightly. Ordered
 *  lists honour `start` and increment. */
function serializeList(list: Element, depth: number, ctx: Ctx): string {
  if (depth > MAX_DEPTH) {
    throw new CapExceeded();
  }
  // serializeList walks direct `<li>` only. A non-`<li>` direct child that carries
  // content — a sibling-nested `<ul>`/`<ol>` (invalid HTML but widespread in legacy
  // CMS and hand-written markup), a stray `<div>`/`<p>`, or a bare TEXT node
  // (`<ul>prefix<li>a</li></ul>`) — would be dropped silently from an INSERTED
  // conversion. Refuse the whole conversion (the TABLE branch's policy) so the handler
  // defers to plain paste, which keeps everything. Walk `childNodes`, not `children`,
  // so a visible direct text node is seen and not just element siblings. Emptiness is
  // the SAME full-strip rule everywhere: a contentless separator between items — a bare
  // `<br>`/`<hr>` element or the whitespace real clipboard HTML pretty-prints between
  // `<li>`s — does not degrade the fragment. SKIP_TAGS children and comments carry no
  // prose either.
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
  const items: string[] = [];
  for (const li of directChildrenByTag(list, "LI")) {
    bump(ctx); // before the emptiness test, so a fragment of 100k empty <li>s still caps
    // An EMPTY <li> is not an item — the leftover bullet a contenteditable keeps
    // after the user clears its text (`<li></li>`, `<li><br></li>`). Load-bearing and
    // now SKIP_TAGS-aware: it also skips a `<li>` whose only block is a text-free grid
    // (`<li><table><style></li>`), so the list stays empty and the branch's
    // unconditional `push(list, true)` never flips the flag for an invisible bullet.
    if (!hasVisibleContent(li)) {
      continue;
    }
    const marker = ordered ? `${Math.min(n, MAX_LIST_NUMBER)}. ` : "- ";
    const item = serializeListItem(li, marker, depth, ctx);
    if (item === "") {
      continue;
    }
    items.push(item);
    // `n` advances only for an item that was actually PUSHED, so neither skip can
    // consume an ordinal that is never emitted and the surviving items stay 1., 2.,
    // … The two skips reject different things — nothing visible at all vs. text
    // that lived entirely in a SKIP_TAGS subtree and serialised away — and
    // advancing inside the marker expression honoured only the first, renumbering
    // everything after a `<li><style>…</style></li>`. Keep the increment here,
    // after both gates.
    n++;
  }
  return items.join("\n");
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
 *  `splitInlineSegments` see different node universes — `serializeBlocks`'
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

/** Strip hard breaks and spaces from BOTH ends of a segment's serialised form,
 *  taking the `HARD_BREAK` token as one unit. A plain `trim()` removes the
 *  token's `\n` first and strands its `\`, so a segment that merely starts or
 *  ends with a `<br>` — the trailing break browsers append to close the last line
 *  of a contenteditable block, `<p>a<br></p>` — rendered a visible backslash.
 *  Interior breaks are untouched: a lone `<br>` between content stays a hard
 *  break. Two linear index scans, matching `wrapEmphasis`' approach. */
function trimSegmentEdges(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end) {
    if (raw[start] === " ") {
      start += 1;
    } else if (raw.startsWith(HARD_BREAK, start)) {
      start += HARD_BREAK.length;
    } else {
      break;
    }
  }
  while (end > start) {
    if (raw[end - 1] === " ") {
      end -= 1;
    } else if (
      end - HARD_BREAK.length >= start &&
      raw.startsWith(HARD_BREAK, end - HARD_BREAK.length)
    ) {
      end -= HARD_BREAK.length;
    } else {
      break;
    }
  }
  return raw.slice(start, end);
}

/** Serialise sibling inline nodes into the blocks they represent and push each.
 *  Shared by the inline-run flush and the `<p>` branch so both split on `<br>`
 *  runs and both drop content-free segments. */
function pushInlineBlocks(
  nodes: Node[],
  depth: number,
  ctx: Ctx,
  push: (s: string, syntax: boolean) => void
): void {
  const contributing = nodes.filter((n) => !contributesNothing(n));
  for (const segment of splitInlineSegments(contributing)) {
    const serialized = segment.map((nd) => serializeInline(nd, depth, ctx)).join("");
    const raw = trimSegmentEdges(serialized);
    const text = escapeMarkers(raw).trim();
    // A segment that edge-trimmed to nothing — a lone `<br>` between two blocks, or
    // `<p><br></p>` — falls out here: `escapeMarkers("") === ""`, so `text` is empty
    // and nothing is pushed. Any surviving break has real content on both sides.
    if (text !== "") {
      // `false`: a paragraph is escaped text, never syntax. Any syntax INSIDE it
      // (emphasis, a link, inline code) was recorded by `serializeInline` at the
      // leaf that emitted it, not here.
      push(text, false);
    }
  }
}

/** Serialise the block-level children of `parent` (body / li / blockquote / an
 *  unknown block) to an array of block strings (no trailing separators). A run of
 *  inline/text nodes is SPLIT at runs of 2+ `<br>` and yields one paragraph per
 *  segment (per-line marker-escaped, content-free segments dropped) — it does not
 *  coalesce into a single paragraph. Recognised block elements map to Markdown.
 *  Any BLOCK_LEVEL_TAGS element recurses into its own block(s) — including one
 *  holding nothing but inline children, which is what keeps `<div>`-per-line
 *  fragments on separate lines — as does an unknown element carrying block
 *  children; everything else folds into the inline run. */
function serializeBlocks(parent: Element, depth: number, ctx: Ctx): string[] {
  if (depth > MAX_DEPTH) {
    throw new CapExceeded();
  }
  const blocks: string[] = [];
  // `syntax` is REQUIRED (no default, not optional), so a branch that goes through
  // `push` cannot compile without stating whether it emits Markdown syntax — TS
  // rejects a bare `push(s)`. That is the whole of the guarantee: `blocks` is a
  // plain array in this same scope, so `blocks.push(s)` also compiles and would
  // emit the block while silently leaving the flag false. Route every block
  // through `push`; never write to `blocks` directly. Same discipline as `count`:
  // the fact is recorded by the funnel, not by a free-standing assignment beside
  // it — which is how one empty <blockquote> used to defeat the caller's defer.
  //
  // Output is counted at its LEAF source (see `count`), never at these aggregating
  // pushes, so nested list/blockquote wrappers don't re-count already-counted
  // content. The two NON-inline leaves (table GFM, <pre> body) are counted
  // explicitly in their branches below; everything else here is inline-derived
  // (already counted) or an O(1) marker/prefix.
  const push = (s: string, syntax: boolean): void => {
    if (syntax) {
      ctx.emittedMarkdownSyntax = true;
    }
    blocks.push(s);
  };
  let inlineRun: Node[] = [];
  const flushInline = (): void => {
    if (inlineRun.length === 0) {
      return;
    }
    const nodes = inlineRun;
    inlineRun = [];
    pushInlineBlocks(nodes, depth, ctx, push);
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
      // `<h1><br></h1>` — a contenteditable's emptied heading — serialises to the
      // lone HARD_BREAK, whose `\` survives collapseWs+trim and used to be pushed
      // as `# \`. hasVisibleContent settles it on the source instead.
      if (hasVisibleContent(el)) {
        // Fold the HARD_BREAK token to a space BEFORE collapsing — a heading is
        // single-line, and collapseWs alone eats the token's `\n` but strands its
        // escaping `\` (`<h1>a<br></h1>` → `# a\`). Same whole-token fold the `<a>`
        // label uses.
        const text = collapseWs(
          serializeChildrenInline(el, depth, ctx).split(HARD_BREAK).join(" ")
        ).trim();
        // Residue guard, the SAME full-strip rule as the predicate: `text` can still
        // be empty when every child was a SKIP_TAGS subtree (`<h1><style>…</style></h1>`)
        // — textContent counts that text, serialisation drops it — or blank-but-nonempty
        // when the predicate passed on its `<hr>` clause and the emit path preserved a
        // joiner (`<h1><hr>&#8205;</h1>`), which `text !== ""` would let through as `# ‍`.
        if (!blankAfterInvisible(text)) {
          push(`${"#".repeat(HEADINGS[tag])} ${text}`, true);
        }
      }
    } else if (tag === "P") {
      flushInline();
      pushInlineBlocks(Array.from(el.childNodes), depth, ctx, push);
    } else if (tag === "UL" || tag === "OL" || tag === "MENU") {
      flushInline();
      // A list of nothing but empty <li>s renders as `-` / `1.\n2.` — non-empty
      // output, which is why `list !== ""` alone used to let it through.
      // serializeList now applies hasVisibleContent per <li>, so an all-empty list
      // really does come back as the empty string and this test is its composition,
      // not a second answer to emptiness. There is deliberately no outer
      // hasVisibleContent(el) call: an <li>'s content is a subset of its list's, so
      // the outer predicate could never be false while any item survived — it was
      // provably unable to change an outcome, and a guard that cannot fire is a
      // guard nobody can reason about.
      const list = serializeList(el, depth, ctx);
      if (list !== "") {
        push(list, true);
      }
    } else if (tag === "PRE") {
      flushInline();
      // <pre> body is a non-inline leaf (verbatim, never through serializeInline)
      // → count it explicitly.
      // Two SEPARATE concerns, deliberately answered differently:
      //  - the richness DECISION is hasVisibleContent, shared with every other
      //    container. A <pre> holding only whitespace is an empty container, not
      //    code — including the pretty-printed `<pre>\n   \n</pre>` and
      //    `<pre>\n\n</pre>` that real clipboard HTML carries, which a "strip one
      //    trailing newline" test still called content. No producer means a blank
      //    line as code, and calling one rich defeats the caller's no-syntax defer
      //    and re-escapes the user's hand-typed Markdown.
      //  - what gets EMITTED is verbatim. Whitespace-significance lives here and
      //    only here: once a <pre> holds real code, its body keeps every leading
      //    space and interior blank line. Do not "tidy" this by emitting
      //    `body.trim()` — that is the mistake this split exists to prevent.
      if (hasVisibleContent(el)) {
        // Body read through `skipTagsText` (SKIP_TAGS-aware) so a `<style>`/`<textarea>`
        // beside real code does not leak into the fence — verbatim otherwise (no
        // collapse), keeping whitespace-significance. Only the trailing newline the
        // browser appends is dropped.
        const body = skipTagsText(el).replace(/\n$/, "");
        // Residue guard: a `<pre><hr></pre>` (or a SKIP_TAGS-only `<pre>`) satisfies the
        // predicate through its `<hr>` clause yet has no code to fence. This TESTS the
        // body for emptiness through the SAME full-strip rule as the predicate — not
        // `.trim()`, which would leave a preserved joiner (`<pre><hr>&#8205;</pre>`) —
        // and it does NOT trim what is emitted, which the paragraph above forbids.
        if (!blankAfterInvisible(body)) {
          push(count(ctx, fenceCode(body, codeLang(el))), true);
        }
      }
    } else if (tag === "BLOCKQUOTE") {
      flushInline();
      // The quote wrapper mail clients leave behind in an otherwise plain reply.
      // hasVisibleContent is the decision; the residue guard then rejects what a
      // non-empty source can still serialise down to — a SKIP_TAGS-only subtree (→ "")
      // or a lone joiner left by a buried <hr> that satisfied the predicate's <hr> clause
      // but serialised to nothing. The SAME full-strip `blankAfterInvisible` rule as the
      // HEADINGS/PRE residues (HARD_BREAK folded to a space first), not `!== ""`, which
      // let a preserved joiner through as `> ‍`.
      if (hasVisibleContent(el)) {
        const quoted = serializeBlocks(el, depth + 1, ctx).join("\n\n");
        if (!blankAfterInvisible(quoted.split(HARD_BREAK).join(" "))) {
          push(prefixLines(quoted, "> "), true);
        }
      }
    } else if (tag === "TABLE") {
      flushInline();
      const gfm = tableElementToGfm(el);
      if (gfm === null) {
        // A table we cannot render (its own row/col/cell cap breached, or a
        // degenerate empty table) must NOT be silently dropped from a mixed
        // prose+table fragment — that would lose data. Abort the whole conversion
        // so the handler defers to plain-text paste, which preserves the table
        // (as tab-separated text) AND the surrounding prose.
        throw new CapExceeded();
      }
      // The ONE branch where "emit this" and "this is rich" have different answers.
      // Both halves are load-bearing:
      //  - EMIT unconditionally: a grid is structure no other flavour of the
      //    fragment expresses, so skipping it would drop the table out of a mixed
      //    paste that something else (a heading, say) already made rich.
      //  - RICH only when a CELL holds visible content: a layout/spacer grid — the
      //    default output of Outlook, mail signatures and newsletter HTML, riding
      //    beside ordinary prose — shows a reader nothing, so calling it rich would
      //    defeat the no-syntax defer (the recurring bug this guard exists to stop). A
      //    text-free grid loses nothing by not being rich: the handler defers and the
      //    clipboard's own bytes carry the grid as tab-separated text.
      // Richness is read PER CELL (td/th/caption), through the same emptiness rule
      // the predicate uses (`blankAfterInvisible(skipTagsText(cell))`) — NOT from
      // hasVisibleContent(el), whose `<hr>` clause would call an `<hr>`-only spacer
      // cell rich, and NOT from a regex on the flattened `gfm` string, which cannot
      // tell a real cell of only `-`/`:` from the table's own grammar. No `<hr>`
      // clause here: an `<hr>` in a cell renders to nothing in GFM.
      // Table GFM is the amplification leaf (colspan/rowspan expansion, built
      // outside this walk's budget) → count it explicitly to abort early.
      const tableIsRich = Array.from(el.querySelectorAll("td, th, caption")).some(
        (cell) => !blankAfterInvisible(skipTagsText(cell))
      );
      push(count(ctx, gfm), tableIsRich);
    } else if (tag === "HR") {
      flushInline();
      // OPT-OUT from hasVisibleContent — a void element has no empty-vs-full variant,
      // so there is no wrong answer for the predicate to give (rationale in its docblock).
      push("---", true);
    } else if (tag === "BR") {
      inlineRun.push(el); // a stray <br> between blocks joins the inline run
    } else {
      const startsOwnBlock =
        BLOCK_LEVEL_TAGS.has(tag) ||
        Array.from(el.children).some((c) => BLOCK_LEVEL_TAGS.has(c.tagName));
      if (startsOwnBlock) {
        // Block-level, or an unknown element wrapping blocks: its children are
        // their own blocks. A block-level element with only inline children still
        // becomes ONE block (its own line) — folding it into the surrounding
        // inline run is what merged `<div>`-per-line clipboard fragments.
        flushInline();
        for (const b of serializeBlocks(el, depth + 1, ctx)) {
          // `false`: these blocks were already emitted by the nested walk, which
          // shares this `ctx` and recorded their richness through its own `push`.
          // Passing `true` here would relabel a plain <div> of text as syntax.
          push(b, false);
        }
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
   *  consumer relies on this: it dispatches `blockPrefix + markdown + blockSuffix`
   *  AFTER calling preventDefault(), so an empty `markdown` would replace a
   *  non-empty selection with blank-line separators alone — a silent deletion.
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
    const ctx: Ctx = { nodes: 0, outLen: 0, emittedMarkdownSyntax: false };
    const out = serializeBlocks(body, 0, ctx).join("\n\n").trim();
    // The incremental `count` cap already aborts amplification mid-build; this
    // final check is a cheap backstop against uncounted wrapper growth (list /
    // blockquote indentation).
    if (out === "" || out.length > MAX_OUTPUT_CHARS) {
      return null;
    }
    return { markdown: out, emittedMarkdownSyntax: ctx.emittedMarkdownSyntax };
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
    if (!(err instanceof CapExceeded)) {
      console.warn("[quoll] rich paste: HTML→Markdown conversion failed", err);
    }
    return null;
  }
}
