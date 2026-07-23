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
//    otherwise smuggle an active marker onto a later line. Autolink-safe schemes
//    are never touched: escaping only hits inline-active characters and
//    line-start markers, never URL bytes, so a bare `http(s)://`/`www.` still
//    autolinks exactly as typed.
//  - Never throws to the handler: caps throw an internal sentinel (`CapExceeded`);
//    `htmlToMarkdown` wraps the whole walk in a try/catch that returns `null` for
//    ANY thrown value, so the handler always has a safe defer-to-plain-paste path.

import { isAllowedUrl } from "../../../markdown/url-allowlist.js";
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

/** Backslash-escape Markdown-inline-active characters (mirrors escapeCell in
 *  html-table-to-gfm.ts) so text renders literally. `\` first so later escapes
 *  are not doubled. `<` escaped so literal `<tag>`-looking text cannot become
 *  inline raw HTML / an autolink; URL bytes are untouched so a bare http(s) URL
 *  still autolinks. `>` is NOT escaped here (inert mid-line — handled at line
 *  start by escapeMarkers), matching the table converter's proven policy. */
function escapeInline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[`*_[\]<~=&]/g, "\\$&");
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

/** Fence an inline-code span: a run of backticks one longer than the longest
 *  backtick run inside the content, space-padded when content borders a backtick
 *  (CommonMark rule). Content is verbatim (never escaped). */
function inlineCode(text: string): string {
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 || text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
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
    return count(ctx, inlineCode(collapseWs(el.textContent ?? "")));
  }
  const inner = serializeChildrenInline(el, depth + 1, ctx); // leaves counted within
  switch (tag) {
    case "STRONG":
    case "B":
      return inner.trim() === "" ? inner : `**${inner}**`;
    case "EM":
    case "I":
      return inner.trim() === "" ? inner : `*${inner}*`;
    case "A": {
      const href = el.getAttribute("href") ?? "";
      // Link text on one line (a newline in the label would break the link).
      const label = inner.replace(/\n/g, " ");
      // Only the wrapping syntax is uncounted (O(1)); the label leaves are counted.
      return isAllowedUrl(href) ? `[${label}](${markdownDestination(href)})` : label;
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

const BLOCK_CHILD_TAGS = new Set([
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
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

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
  const runs = body.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
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
  if (!Number.isFinite(n)) {
    n = 1;
  }
  const items: string[] = [];
  for (const li of directChildrenByTag(list, "LI")) {
    bump(ctx);
    const marker = ordered ? `${n++}. ` : "- ";
    items.push(serializeListItem(li, marker, depth, ctx));
  }
  return items.join("\n");
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
    const raw = inlineRun.map((nd) => serializeInline(nd, depth, ctx)).join("");
    inlineRun = [];
    const text = escapeMarkers(raw).trim();
    if (text !== "") {
      push(text);
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
      const text = collapseWs(serializeChildrenInline(el, depth, ctx)).trim();
      if (text !== "") {
        push(`${"#".repeat(HEADINGS[tag])} ${text}`);
      }
    } else if (tag === "P") {
      flushInline();
      const text = escapeMarkers(serializeChildrenInline(el, depth, ctx)).trim();
      if (text !== "") {
        push(text);
      }
    } else if (tag === "UL" || tag === "OL") {
      flushInline();
      push(serializeList(el, depth, ctx));
    } else if (tag === "PRE") {
      flushInline();
      // <pre> body is a non-inline leaf (verbatim, never through serializeInline)
      // → count it explicitly.
      push(count(ctx, fenceCode((el.textContent ?? "").replace(/\n$/, ""), codeLang(el))));
    } else if (tag === "BLOCKQUOTE") {
      flushInline();
      push(prefixLines(serializeBlocks(el, depth + 1, ctx).join("\n\n"), "> "));
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
      push(count(ctx, gfm));
    } else if (tag === "HR") {
      flushInline();
      push("---");
    } else if (tag === "BR") {
      inlineRun.push(el); // a stray <br> between blocks joins the inline run
    } else {
      const hasBlockChild = Array.from(el.children).some((c) => BLOCK_CHILD_TAGS.has(c.tagName));
      if (hasBlockChild) {
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

export function htmlToMarkdown(html: string): string | null {
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
    const ctx: Ctx = { nodes: 0, outLen: 0 };
    const out = serializeBlocks(body, 0, ctx).join("\n\n").trim();
    // The incremental `count` cap already aborts amplification mid-build; this
    // final check is a cheap backstop against uncounted wrapper growth (list /
    // blockquote indentation).
    if (out === "" || out.length > MAX_OUTPUT_CHARS) {
      return null;
    }
    return out;
  } catch {
    // ANY error (cap sentinel, stack overflow, unexpected) → defer to plain paste.
    return null;
  }
}
