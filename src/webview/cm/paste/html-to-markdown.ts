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
//  - Whether a container is EMPTY is asked once, of the source element, by
//    `hasVisibleContent` — never re-derived from a branch's own rendered output,
//    which is what six separate branches got wrong (an empty list renders `-`,
//    not ``). Every branch that pushes a BLOCK, or that sets
//    `emittedMarkdownSyntax` from the CONTAINER ITSELF, routes through it. Three
//    classes deliberately do not, each for its own reason, and none of them is
//    covered by the predicate — do not assume otherwise when changing them:
//     · `<hr>` opts out. A void element: the predicate would answer "empty" for
//       every one, and thematic breaks would stop converting altogether.
//     · `<table>` emits its grid unconditionally and takes only its RICHNESS from
//       the predicate — the one branch where those two answers differ.
//     · `<strong>`/`<b>`/`<em>`/`<i>` never consult it. Their flag comes from
//       `emphasize`, which records whether markers were actually written, and
//       their emptiness is settled upstream instead — by `collapseWs`, which drops
//       whitespace and the zero-width class before `wrapEmphasis` ever sees them.
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
 *  The zero-width class (U+200B ZERO WIDTH SPACE, U+200C/200D joiners, U+2060 word
 *  joiner, U+FEFF) is deleted rather than folded into the whitespace run: these
 *  characters occupy no width, so turning one into a space would insert a gap
 *  between two letters that touch. U+00A0 needs no clause — it IS `\s`, and that is
 *  the shape this follows: ONE place decides what counts as invisible, so
 *  `hasVisibleContent`, `emphasize` and the heading/list residue guards all inherit
 *  the same answer instead of each growing its own test. That matters because
 *  U+200B is what a contenteditable (Notion / Slack / Quill / ProseMirror) leaves
 *  in a block the user has emptied — i.e. precisely the leftover container the
 *  emptiness guard exists to reject — and `String.prototype.trim()` does not strip
 *  it. Without this, `<h1>&#8203;</h1>` counted as content and flipped
 *  `emittedMarkdownSyntax`, re-escaping the user's hand-typed Markdown. */
function collapseWs(text: string): string {
  return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, " ");
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
 *  inputs. */
function emphasize(ctx: Ctx, inner: string, marker: string): string {
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
    // holding nothing — so the emptiness question goes to hasVisibleContent, and no
    // flag is set when it says no.
    const body = collapseWs(el.textContent ?? "");
    // `body === ""` is the second, DIFFERENT question the other containers ask after
    // the predicate — did what this branch EMITS survive? — and it is what keeps the
    // predicate's `<hr>` clause honest here: an `<hr>` nested in a `<code>` is
    // visible content by that clause yet contributes no code, and an inline `<code>`
    // has nothing to fence. Emitted on the same normalised body the test read, so
    // the two cannot disagree.
    if (!hasVisibleContent(el) || body === "") {
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
      // `label === ""` is the second, DIFFERENT question — did serialisation keep
      // anything? — that HEADINGS (`text !== ""`), BLOCKQUOTE (`quoted !== ""`) and
      // serializeListItem (`blocks.length === 0`) each ask after the predicate, and
      // that this branch was alone in not asking. It is not a second answer to
      // emptiness: hasVisibleContent reads `el.textContent`, which counts text inside
      // SKIP_TAGS subtrees, while the label comes from serializeChildrenInline,
      // which drops them. `<a href="…"><style>.c{}</style></a>` sits in the gap
      // between those two projections and emitted an invisible `[](url)` WITH the
      // flag set — the same defer-defeating bug, through the one branch missing the
      // pattern.
      if (!hasVisibleContent(el) || label === "") {
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
 *  and every branch that pushes a block, or sets `emittedMarkdownSyntax` from the
 *  container itself, routes through it FIRST. Not "every branch below": `CODE` and
 *  `A` are declared above this point, and the emphasis tags never consult it at all
 *  — the module header lists the three non-users and why each one is safe. An empty
 *  container that sets the flag
 *  defeats the caller's no-syntax defer and re-escapes Markdown the user typed by
 *  hand (`- [ ]` → `\- \[ \]`) — the bug this whole guard exists to stop.
 *
 *  ONE deliberate opt-out, stated here rather than left implicit at its branch:
 *  `<hr>`. It is a void element, so this predicate would answer "empty" for EVERY
 *  one of them and thematic breaks would stop converting altogether — and that is
 *  safe precisely because an `<hr>` holds nothing: it has no empty-vs-full variant,
 *  so there is no wrong answer for the predicate to give.
 *
 *  `<table>` used to be a second opt-out, on two claims that were both false. A
 *  table is NOT inherently content-free — it has exactly the empty-vs-full variant
 *  an `<hr>` lacks, and the empty one (a spacer/layout grid) is what Outlook and
 *  newsletter HTML emit beside real prose. And `tableElementToGfm` does NOT
 *  separately protect against it: it returns `null` only for a table with no cells
 *  AT ALL, never for a table whose cells are merely empty. The TABLE branch now
 *  emits its grid unconditionally but takes its RICHNESS from this predicate; see
 *  the comment there for why those two answers differ only for a table.
 *
 *  Visible content is TEXT — normalised by `collapseWs`, so neither whitespace nor
 *  the zero-width class counts — OR an `<hr>`, and `<hr>` ONLY. That second clause
 *  is not a tag list creeping in through the back door: `<hr>` is the one construct
 *  this converter emits from a source element that has no text at all, so it is
 *  exactly the set the text test would otherwise miss, and it is the same single
 *  exception the opt-out above already makes — stated once instead of twice.
 *  `<img>` is the case that proves the clause must stay this narrow: it renders in
 *  a browser but serialises to NOTHING here, so counting it would push an empty
 *  wrapper. So does a text-free `<table>`, deliberately — see the TABLE branch.
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
  // Through `collapseWs`, not straight to `trim()`: `trim()` strips U+00A0 but NOT
  // the zero-width class, so a contenteditable's emptied block (`<h1>&#8203;</h1>`)
  // read as content. Sharing the text path's own normaliser is what keeps that
  // answer identical here and at `emphasize` — see the `collapseWs` docblock.
  return collapseWs(el.textContent ?? "").trim() !== "" || el.querySelector("hr") !== null;
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
  if (blocks.length === 0) {
    // No marker for an item with no blocks. `serializeList` has already refused
    // the empty <li>s via hasVisibleContent, so what reaches here is an item whose
    // text lives entirely in a SKIP_TAGS subtree (`<li><style>…</style></li>`) —
    // a different question (did serialisation keep anything?) than the one
    // hasVisibleContent answers, not a second answer to it. Returning `marker` here
    // is what emitted the bare `-` that made an empty bullet look like rich
    // content; the caller drops the empty string.
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
    // after the user clears its text, which arrives as `<li></li>` or `<li><br></li>`.
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
    // … The two skips reject different things — no text at all vs. text that lived
    // entirely in a SKIP_TAGS subtree and serialised away — and advancing inside the
    // marker expression honoured only the first, renumbering everything after a
    // `<li><style>…</style></li>`. Keep the increment here, after both gates.
    n++;
  }
  return items.join("\n");
}

function isBr(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE && (node as Element).tagName === "BR";
}

/** A text node holding only whitespace. Transparent inside a `<br>` run — real
 *  clipboard HTML pretty-prints `<br>\n<br>`, and that newline must not break the
 *  run into two single breaks. */
function isBlankText(node: Node): boolean {
  return node.nodeType === TEXT_NODE && (node.textContent ?? "").trim() === "";
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
    // After edge-trimming, a segment whose only content was hard breaks and
    // whitespace — a lone `<br>` between two blocks, or `<p><br></p>` — is exactly
    // empty, and any surviving break has real content on both sides.
    if (raw === "") {
      continue;
    }
    const text = escapeMarkers(raw).trim();
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
        const text = collapseWs(serializeChildrenInline(el, depth, ctx)).trim();
        // Can still come out empty when every child was a SKIP_TAGS subtree
        // (`<h1><style>…</style></h1>`): textContent counts that text, serialisation
        // drops it. A different question from the one above, not a second answer.
        if (text !== "") {
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
        const body = (el.textContent ?? "").replace(/\n$/, "");
        // Residue guard, the same second question HEADINGS and BLOCKQUOTE ask: a
        // `<pre><hr></pre>` satisfies the predicate through its `<hr>` clause yet has
        // no code to fence. This TESTS the body for emptiness; it does not trim what
        // is emitted, which the paragraph above forbids.
        if (body !== "") {
          push(count(ctx, fenceCode(body, codeLang(el))), true);
        }
      }
    } else if (tag === "BLOCKQUOTE") {
      flushInline();
      // The quote wrapper mail clients leave behind in an otherwise plain reply.
      // hasVisibleContent is the decision; `quoted !== ""` then guards the residue a
      // non-empty source can still serialise away to (a SKIP_TAGS-only subtree),
      // exactly as at HEADINGS.
      if (hasVisibleContent(el)) {
        const quoted = serializeBlocks(el, depth + 1, ctx).join("\n\n");
        if (quoted !== "") {
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
      // The ONE branch where "emit this" and "this is rich" have different answers,
      // so it is the one branch that passes the predicate's verdict to `push`
      // instead of a literal. Both halves are load-bearing:
      //  - EMIT unconditionally: a grid is structure no other flavour of the
      //    fragment expresses, so skipping it would drop the table out of a mixed
      //    paste that something else (a heading, say) already made rich.
      //  - RICH only when its cells hold text: a layout/spacer grid — the default
      //    output of Outlook, mail signatures and newsletter HTML, riding beside
      //    ordinary prose — shows a reader nothing, and calling it rich defeats the
      //    caller's no-syntax defer and re-escapes Markdown the user typed by hand
      //    (`- [ ]` → `\- \[ \]`), the bug this whole guard exists to stop. A
      //    text-free grid loses nothing by not being rich: the handler then defers
      //    and the clipboard's own bytes carry the grid as tab-separated text.
      // Table GFM is the amplification leaf (colspan/rowspan expansion, built
      // outside this walk's budget) → count it explicitly to abort early.
      push(count(ctx, gfm), hasVisibleContent(el));
    } else if (tag === "HR") {
      flushInline();
      // OPT-OUT from hasVisibleContent (see its docblock): an <hr> is inherently
      // content-free — it is a void element, so the predicate would say "empty" for
      // EVERY one of them and the thematic break would stop converting altogether.
      // Safe precisely because it holds nothing: there is no empty-vs-full variant
      // of an <hr>, so there is no wrong answer for the predicate to give.
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
    // unrenderable table) and stays silent; anything else is a bug here and gets a
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
