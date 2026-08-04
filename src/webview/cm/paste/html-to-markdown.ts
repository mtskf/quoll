// Pure converter: an HTML `text/html` clipboard fragment → an equivalent
// Markdown string, or `null` when there is nothing convertible (the caller then
// falls back to normal paste). No dependency, no side effects — `DOMParser` is a
// webview/browser global (happy-dom provides it under test), so this stays inside
// Quoll's supply-chain default-deny.
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
//    text typed by hand would not.
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
  // byte. The handler uses it to decide that a `text/html` flavour carried
  // nothing the clipboard's `text/plain` does not already carry.
  rich: boolean;
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

/** Collapse all whitespace runs (incl. newlines) to a single space — HTML's own
 *  inline whitespace behaviour. Applied to TEXT NODES only (never to `<pre>`,
 *  which the block path reads verbatim) so an interior newline cannot form
 *  indented code or smuggle an unescaped line start; real breaks come only from
 *  `<br>` and block structure. */
function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ");
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

/** Record that an emphasis wrapper actually emitted markers. `wrapEmphasis`
 *  returns its input unchanged when the span is all-whitespace / `<br>`-only, and
 *  that degenerate case emits no syntax — so compare rather than assume. */
function markSyntax(ctx: Ctx, inner: string, wrapped: string): string {
  if (wrapped !== inner) {
    ctx.rich = true;
  }
  return wrapped;
}

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
    return count(ctx, "\\\n"); // hard break (backslash form survives trimming)
  }
  if (tag === "CODE") {
    // Inline <code> (a <code> child of <pre> is handled by the block path).
    ctx.rich = true;
    return count(ctx, inlineCode(collapseWs(el.textContent ?? "")));
  }
  const inner = serializeChildrenInline(el, depth + 1, ctx); // leaves counted within
  switch (tag) {
    case "STRONG":
    case "B":
      return markSyntax(ctx, inner, wrapEmphasis(inner, "**"));
    case "EM":
    case "I":
      return markSyntax(ctx, inner, wrapEmphasis(inner, "*"));
    case "A": {
      const href = el.getAttribute("href") ?? "";
      // Link text on one line (a newline in the label would break the link).
      const label = inner.replace(/\n/g, " ");
      // Only the wrapping syntax is uncounted (O(1)); the label leaves are counted.
      if (!isAllowedUrl(href)) {
        return label; // rejected destination → bare label, no syntax emitted
      }
      ctx.rich = true;
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
 *  TABLE / HR / H1-6) are listed too because (b) still asks about them. */
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
]);

// The list is the HTML block-level container set, not a hand-picked subset: an
// omitted block tag silently folds back into the inline run — the exact bug this
// task fixes — so err toward listing a tag. Omission is the only failure mode; a
// wrongly-listed inline tag would merely give it its own line. Add to this set
// rather than introducing a second one.

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
    return marker.trimEnd();
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
    bump(ctx);
    const marker = ordered ? `${Math.min(n++, MAX_LIST_NUMBER)}. ` : "- ";
    items.push(serializeListItem(li, marker, depth, ctx));
  }
  return items.join("\n");
}

/** The hard-break token `serializeInline` emits for `<br>`: a backslash
 *  immediately followed by a newline. Text nodes cannot contribute a newline
 *  (`collapseWs` collapses every whitespace run to a space, `<pre>` never takes
 *  the inline path, and an `<a>` label has its newlines replaced), so a `\n` in
 *  an inline fragment ALWAYS comes from a `<br>` and always carries its own
 *  leading backslash — matching the two-character token is unambiguous. */
const HARD_BREAK = "\\\n";

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
  const settle = (): void => {
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
      settle();
      current.push(node);
    }
  }
  settle();
  segments.push(current);
  return segments;
}

/** Serialise sibling inline nodes into the blocks they represent and push each.
 *  Shared by the inline-run flush and the `<p>` branch so both split on `<br>`
 *  runs and both drop content-free segments. */
function pushInlineBlocks(nodes: Node[], depth: number, ctx: Ctx, push: (s: string) => void): void {
  for (const segment of splitInlineSegments(nodes)) {
    const raw = segment.map((nd) => serializeInline(nd, depth, ctx)).join("");
    // A segment whose only content is hard breaks / whitespace — a lone `<br>`
    // between two blocks, or `<p><br></p>` — is not content. Test it on the
    // UNTRIMMED string: `trim()` strips the token's newline first, leaving a bare
    // `\` that looks like content and used to be emitted as its own block.
    if (raw.split(HARD_BREAK).join("").trim() === "") {
      continue;
    }
    const text = escapeMarkers(raw).trim();
    if (text !== "") {
      push(text);
    }
  }
}

/** Serialise the block-level children of `parent` (body / li / blockquote / an
 *  unknown block) to an array of block strings (no trailing separators). A run of
 *  inline/text nodes coalesces into one paragraph (per-line marker-escaped);
 *  recognised block elements map to Markdown; unknown elements carrying block
 *  children recurse, else fold into the inline run. */
function serializeBlocks(parent: Element, depth: number, ctx: Ctx): string[] {
  if (depth > MAX_DEPTH) {
    throw new CapExceeded();
  }
  const blocks: string[] = [];
  // Plain push: output is counted at its LEAF source (see `count`), never at these
  // aggregating pushes, so nested list/blockquote wrappers don't re-count already-
  // counted content. The two NON-inline leaves (table GFM, <pre> body) are counted
  // explicitly in their branches below; everything else here is inline-derived
  // (already counted) or an O(1) marker/prefix.
  const push = (s: string): void => {
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
      const text = collapseWs(serializeChildrenInline(el, depth, ctx)).trim();
      if (text !== "") {
        ctx.rich = true;
        push(`${"#".repeat(HEADINGS[tag])} ${text}`);
      }
    } else if (tag === "P") {
      flushInline();
      pushInlineBlocks(Array.from(el.childNodes), depth, ctx, push);
    } else if (tag === "UL" || tag === "OL" || tag === "MENU") {
      flushInline();
      const list = serializeList(el, depth, ctx);
      if (list !== "") {
        ctx.rich = true;
        push(list);
      }
    } else if (tag === "PRE") {
      flushInline();
      // <pre> body is a non-inline leaf (verbatim, never through serializeInline)
      // → count it explicitly. Guarded like HEADINGS / UL: an EMPTY container is
      // not rich content, and flipping ctx.rich for one would defeat the caller's
      // no-syntax defer — a content-free <pre>/<blockquote> is exactly the wrapper
      // mail clients leave behind in an otherwise plain fragment, so an unguarded
      // flag re-escapes the user's hand-typed Markdown.
      const body = (el.textContent ?? "").replace(/\n$/, "");
      // The asymmetry with BLOCKQUOTE below is deliberate: `<pre>  </pre>` DOES
      // emit a fence, because a code block is whitespace-significant and those two
      // spaces are content. A whitespace-only <blockquote> is caught instead by its
      // inner serialisation trimming to "". Do not "fix" this by trimming `body`.
      if (body !== "") {
        ctx.rich = true;
        push(count(ctx, fenceCode(body, codeLang(el))));
      }
    } else if (tag === "BLOCKQUOTE") {
      flushInline();
      const quoted = serializeBlocks(el, depth + 1, ctx).join("\n\n");
      if (quoted !== "") {
        ctx.rich = true;
        push(prefixLines(quoted, "> "));
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
      // Table GFM is the amplification leaf (colspan/rowspan expansion, built
      // outside this walk's budget) → count it explicitly to abort early.
      ctx.rich = true;
      push(count(ctx, gfm));
    } else if (tag === "HR") {
      flushInline();
      ctx.rich = true;
      push("---");
    } else if (tag === "BR") {
      inlineRun.push(el); // a stray <br> between blocks joins the inline run
    } else {
      const hasBlockChild = Array.from(el.children).some((c) => BLOCK_LEVEL_TAGS.has(c.tagName));
      if (BLOCK_LEVEL_TAGS.has(tag) || hasBlockChild) {
        // Block-level, or an unknown element wrapping blocks: its children are
        // their own blocks. A block-level element with only inline children still
        // becomes ONE block (its own line) — folding it into the surrounding
        // inline run is what merged `<div>`-per-line clipboard fragments.
        flushInline();
        for (const b of serializeBlocks(el, depth + 1, ctx)) {
          push(b);
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
  markdown: string;
  emittedMarkdownSyntax: boolean;
}

export function htmlToMarkdown(html: string): HtmlToMarkdownResult | null {
  if (html.length > MAX_HTML_INPUT_CHARS) {
    return null;
  }
  let body: Element | null;
  try {
    body = new DOMParser().parseFromString(html, "text/html").body;
  } catch {
    return null;
  }
  if (!body) {
    return null;
  }
  try {
    const ctx: Ctx = { nodes: 0, outLen: 0, rich: false };
    const out = serializeBlocks(body, 0, ctx).join("\n\n").trim();
    // The incremental `count` cap already aborts amplification mid-build; this
    // final check is a cheap backstop against uncounted wrapper growth (list /
    // blockquote indentation).
    if (out === "" || out.length > MAX_OUTPUT_CHARS) {
      return null;
    }
    return { markdown: out, emittedMarkdownSyntax: ctx.rich };
  } catch {
    // ANY error (cap sentinel, stack overflow, unexpected) → defer to plain paste.
    return null;
  }
}
