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
    const out = escapeMarkers(serializeChildrenInline(body, 0, ctx)).trim();
    if (out === "" || out.length > MAX_OUTPUT_CHARS) {
      return null;
    }
    return out;
  } catch {
    // ANY error (cap sentinel, stack overflow, unexpected) → defer to plain paste.
    return null;
  }
}
