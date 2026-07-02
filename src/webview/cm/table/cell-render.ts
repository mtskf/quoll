// Render a GFM table cell's raw Markdown to a flat list of DOM nodes for the
// readonly table widget. The pipeline is:
//
//   tokenize(raw) → Segment<CellLeaf>[]
//     → resolveInline(segments) → Resolved<CellLeaf>[]   [inline-emphasis.ts]
//       → renderReadonly(ir, raw) → Node[]
//
// The `tokenize` pass handles constructs that bind tighter than emphasis —
// inline links `[text](url)`, images `![alt](url)`, autolinks `<url>`, inline
// code `` `code` ``, and CommonMark §6.1 backslash escapes — and emits
// emphasis `*`/`_` delimiter runs (with their §6.2 left/right-flanking flags)
// for `resolveInline`, which runs the full CommonMark §6.4 delimiter-stack
// algorithm (nesting, rule of 3, `***triple***` splitting). The C4a orchestrator
// drops its reveal spans inside the widget range via the `quollBlockReplaceZones`
// facet, so the widget owns the rendering for these constructs WITHOUT a coloured
// reveal highlight bleeding in.
//
// Every URL is FIRST decoded then gated via the SHARED
// `renderSafeMarkdownDestination` (cm-side wrapper over the canonical
// `decodeMarkdownDestination` + `renderSafeUrl`). Without the decode step,
// `javascript&#58;…` and `javascript\:…` look schemeless to `isAllowedUrl`'s
// regex, get classified as "relative", and ship as a live `<a href>` that the
// browser resolves back into a JS URL → XSS. Routing both this renderer and the
// block-image widget through the one shared function keeps the two render gates
// from drifting. Blocked URLs render as inert text identical to the source
// slice (no live `<a>`, no `<img>`). The URL-safety verdict is computed in the
// tokenizer and carried in the IR leaf; renderReadonly only reads it.

import { renderSafeMarkdownDestination } from "../../../markdown/render-safe-markdown-destination.js";
import { type Resolved, resolveInline, type Segment, type Span } from "./inline-emphasis.js";

// Per-construct IR leaf type. Each leaf carries source-position spans for
// every syntactic boundary so PR2 can dim punctuation characters independently.
// No leaf stores literal text — renderReadonly derives strings by slicing `raw`.
export type CellLeaf =
  | { kind: "escape"; marker: Span; char: Span }
  | { kind: "code"; openFence: Span; content: Span; closeFence: Span }
  | {
      kind: "link";
      openBracket: Span;
      label: Span;
      closeBracket: Span;
      openParen: Span;
      dest: Span;
      closeParen: Span;
      safeUrl: string | null;
    }
  | {
      kind: "image";
      bang: Span;
      openBracket: Span;
      alt: Span;
      closeBracket: Span;
      openParen: Span;
      dest: Span;
      closeParen: Span;
      safeUrl: string | null;
    }
  | {
      kind: "autolink";
      openAngle: Span;
      content: Span;
      closeAngle: Span;
      safeUrl: string | null;
    };

// Exhaustiveness guard for the `CellLeaf` discriminated union: if a future
// leaf kind is added without a matching `renderReadonly` arm, the `switch`
// default narrows `x` to `never` only when every kind is handled — so the call
// fails to type-check, surfacing the gap at compile time instead of silently
// dropping the leaf at runtime.
function assertNever(x: never): never {
  throw new Error(`Unhandled CellLeaf kind: ${JSON.stringify(x)}`);
}

// Plain-click on a widget-internal link must NOT navigate the browser — that
// bypasses the widget's caret-dispatch handler and the user loses the only
// path to edit the link source. We preventDefault() unless the user holds a
// platform modifier (Cmd on Mac, Ctrl elsewhere), matching VS Code Markdown
// preview / Go-to-Definition convention. The bubbled click then reaches the
// widget root and fires reveal-on-caret (C6b smoke #5).
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const LINK_TOOLTIP = `${IS_MAC ? "Cmd" : "Ctrl"}+click to open`;

// Modifier-click is the "external navigate" escape hatch — but only for
// hrefs that resolve to an external target the user can act on (https/http
// open in the system browser, mailto opens a mail client). `isAllowedUrl`
// deliberately accepts schemeless strings (relative paths / fragments) as
// "safe", which ships them as live `<a href="./doc.md">` etc. Inside the
// VS Code webview iframe, modifier-click on a relative or fragment href
// has no defined behaviour (may navigate the frame, may do nothing).
// preventDefault unless the raw href matches one of the absolute schemes
// that are safe to open externally (https, http, mailto — mirrors
// ALLOWED_URL_SCHEMES in url-allowlist.ts; keep in sync if that set
// changes). Use `getAttribute("href")` (NOT `a.href`) so we read what
// the renderer wrote; `a.href` is normalised by the browser to an
// absolute URL even for relative input, which would defeat the check.
const ABSOLUTE_HREF_RE = /^(?:https?:|mailto:)/i;

function attachLinkClickGuard(a: HTMLAnchorElement): void {
  a.title = LINK_TOOLTIP;
  a.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey) {
      const href = a.getAttribute("href") ?? "";
      if (ABSOLUTE_HREF_RE.test(href)) {
        return;
      }
    }
    event.preventDefault();
  });
}

// Single chokepoint for the decode → gate pipeline. Every link / image /
// autolink destination passes through here, which routes to the SHARED
// renderSafeMarkdownDestination so the table-cell render-gate cannot drift
// from the block-image render-gate (image/image-field.ts): the same decode
// (so `javascript&#58;…` / `javascript\:…` resolve to `javascript:…`) and the
// same allowlist gate. Returns the safe URL string or null when not allowed.
function resolveDest(rawDest: string): string | null {
  const safe = renderSafeMarkdownDestination(rawDest);
  return safe.kind === "safe" ? safe.url : null;
}

// CommonMark "Unicode whitespace character": Unicode Zs (which includes the
// regular space U+0020) plus tab, LF, FF, CR. Deliberately NOT JS `\s`, which
// also matches vertical tab (U+000B), BOM (U+FEFF), and Zl/Zp — none of which
// CommonMark treats as whitespace (they would wrongly disqualify a flanking
// run). String start/end count as whitespace (the " " sentinel from charAfter
// / charBefore is in Zs).
function isWhitespace(ch: string): boolean {
  return ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || /^\p{Zs}$/u.test(ch);
}

// CommonMark "punctuation character": an ASCII punctuation character, or any
// Unicode P (punctuation) OR S (symbol) category code point — symbols such as
// `©` and currency/math signs ARE punctuation for flanking. The `u` flag with
// `^…$` matches one whole code point, so an astral character passed in from
// charBefore / charAfter classifies correctly.
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
function isPunct(ch: string): boolean {
  return ASCII_PUNCT.test(ch) || /^[\p{P}\p{S}]$/u.test(ch);
}

// The full code point (1–2 UTF-16 units) immediately before / after a
// delimiter run. Returning whole code points — not raw `raw[i]` units — keeps
// an astral character adjacent to a run from being read as a lone surrogate,
// which `isPunct` / `isWhitespace` would misclassify. A space sentinel marks
// the line boundary (start / end of input count as whitespace).
function charBefore(s: string, i: number): string {
  if (i <= 0) {
    return " ";
  }
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return s.slice(i - 2, i); // valid surrogate pair — return the whole code point
    }
  }
  return s[i - 1]; // BMP char, or a lone surrogate (classified as a regular char)
}
function charAfter(s: string, i: number): string {
  if (i >= s.length) {
    return " ";
  }
  return String.fromCodePoint(s.codePointAt(i) as number);
}

// CommonMark delimiter-run flanking. `before`/`after` are the bounding code
// points (a space sentinel at string start/end). The `_` branch enforces the
// intraword-`_` restriction (§6.4): a `_` run can only open when it is not
// right-flanking (or preceded by punctuation), and can only close when it is
// not left-flanking (or followed by punctuation).
function flanking(
  ch: "*" | "_",
  before: string,
  after: string
): { canOpen: boolean; canClose: boolean } {
  const beforeWs = isWhitespace(before);
  const afterWs = isWhitespace(after);
  const beforePunct = isPunct(before);
  const afterPunct = isPunct(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  if (ch === "_") {
    // Intraword `_` restriction (CommonMark §6.4).
    return {
      canOpen: leftFlanking && (!rightFlanking || beforePunct),
      canClose: rightFlanking && (!leftFlanking || afterPunct),
    };
  }
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

// Tokenize a cell's raw Markdown into a flat segment list. Links / images /
// autolinks / code spans / backslash escapes are resolved here (with the
// URL-safety gate intact); `*`/`_` emphasis runs become delimiter segments
// for `resolveInline`. Inline constructs bind tighter than emphasis, so their
// inner `*`/`_` never enter the delimiter stack — they are owned by the
// resolved leaf node.
//
// Output is Segment<CellLeaf>[] — a DOM-free IR. Each leaf carries its
// boundary spans and the pre-computed URL-safety verdict; renderReadonly
// drives the DOM from it without re-running the security gate.
function tokenize(raw: string): Segment<CellLeaf>[] {
  const segments: Segment<CellLeaf>[] = [];
  let textStart = -1; // start of the current pending-text run (-1 = none)
  let textVal = "";

  const flushText = (): void => {
    if (textVal.length > 0) {
      segments.push({
        kind: "text",
        value: textVal,
        span: { from: textStart, to: textStart + textVal.length },
      });
      textVal = "";
      textStart = -1;
    }
  };
  const addChar = (ch: string, pos: number): void => {
    if (textVal.length === 0) {
      textStart = pos;
    }
    textVal += ch;
  };

  let i = 0;
  while (i < raw.length) {
    // Backslash escape — CommonMark §6.1. A backslash before an ASCII
    // punctuation character makes that character literal (this subsumes the
    // GFM `\|`, the `\\` backslash-parity, and the `\*` / `\_` emphasis
    // suppression). A backslash before anything else (or end of input) is a
    // literal backslash.
    if (raw[i] === "\\") {
      const next = raw[i + 1];
      if (next !== undefined && ASCII_PUNCT.test(next)) {
        // Escape sequence: emit as a leaf with boundary spans so the partition
        // invariant holds and PR2 can dim the backslash marker separately.
        flushText();
        segments.push({
          kind: "leaf",
          leaf: {
            kind: "escape",
            marker: { from: i, to: i + 1 },
            char: { from: i + 1, to: i + 2 },
          },
          span: { from: i, to: i + 2 },
        });
        i += 2;
      } else {
        // Lone backslash — literal character in the text run.
        addChar("\\", i);
        i += 1;
      }
      continue;
    }
    // Inline code: `…` (single-backtick run only for this slice; multi-backtick
    // code spans + CommonMark code normalization are deferred out of C6c scope —
    // multi-backtick runs fall through to literal text).
    if (raw[i] === "`") {
      let runEnd = i + 1;
      while (runEnd < raw.length && raw[runEnd] === "`") {
        runEnd++;
      }
      if (runEnd - i === 1) {
        const closeBacktick = raw.indexOf("`", i + 1);
        if (closeBacktick > i) {
          flushText();
          segments.push({
            kind: "leaf",
            leaf: {
              kind: "code",
              openFence: { from: i, to: i + 1 },
              content: { from: i + 1, to: closeBacktick },
              closeFence: { from: closeBacktick, to: closeBacktick + 1 },
            },
            span: { from: i, to: closeBacktick + 1 },
          });
          i = closeBacktick + 1;
          continue;
        }
      }
    }
    // Emphasis delimiter run: `*` or `_`. Flanking is computed from the source
    // characters bounding the run (string boundaries count as whitespace).
    if (raw[i] === "*" || raw[i] === "_") {
      const ch = raw[i] as "*" | "_";
      let runEnd = i + 1;
      while (runEnd < raw.length && raw[runEnd] === ch) {
        runEnd++;
      }
      const { canOpen, canClose } = flanking(ch, charBefore(raw, i), charAfter(raw, runEnd));
      flushText();
      segments.push({ kind: "delim", ch, span: { from: i, to: runEnd }, canOpen, canClose });
      i = runEnd;
      continue;
    }
    // Inline image: ![alt](url)
    if (raw[i] === "!" && raw[i + 1] === "[") {
      const img = tryParseLink(raw, i + 1);
      if (img !== null) {
        const safeUrl = resolveDest(img.url);
        // img.start = i+1 (the `[`), img.labelEnd = index of `]`,
        // img.urlStart = labelEnd+2, img.end = j+1 (past the `)`)
        const bangSpan: Span = { from: i, to: i + 1 };
        const openBracket: Span = { from: i + 1, to: i + 2 };
        const labelSpan: Span = { from: i + 2, to: img.labelEnd };
        const closeBracket: Span = { from: img.labelEnd, to: img.labelEnd + 1 };
        const openParen: Span = { from: img.labelEnd + 1, to: img.labelEnd + 2 };
        const destSpan: Span = { from: img.labelEnd + 2, to: img.urlEnd };
        const closeParen: Span = { from: img.urlEnd, to: img.end };
        flushText();
        segments.push({
          kind: "leaf",
          leaf: {
            kind: "image",
            bang: bangSpan,
            openBracket,
            alt: labelSpan,
            closeBracket,
            openParen,
            dest: destSpan,
            closeParen,
            safeUrl,
          },
          span: { from: i, to: img.end },
        });
        i = img.end;
        continue;
      }
    }
    // Inline link: [text](url)
    if (raw[i] === "[") {
      const link = tryParseLink(raw, i);
      if (link !== null) {
        const safeUrl = resolveDest(link.url);
        const openBracket: Span = { from: i, to: i + 1 };
        const labelSpan: Span = { from: i + 1, to: link.labelEnd };
        const closeBracket: Span = { from: link.labelEnd, to: link.labelEnd + 1 };
        const openParen: Span = { from: link.labelEnd + 1, to: link.labelEnd + 2 };
        const destSpan: Span = { from: link.labelEnd + 2, to: link.urlEnd };
        const closeParen: Span = { from: link.urlEnd, to: link.end };
        flushText();
        segments.push({
          kind: "leaf",
          leaf: {
            kind: "link",
            openBracket,
            label: labelSpan,
            closeBracket,
            openParen,
            dest: destSpan,
            closeParen,
            safeUrl,
          },
          span: { from: i, to: link.end },
        });
        i = link.end;
        continue;
      }
    }
    // Autolink: <url>
    if (raw[i] === "<") {
      const closeAngle = raw.indexOf(">", i + 1);
      if (closeAngle > i) {
        const inside = raw.slice(i + 1, closeAngle);
        // Crude autolink shape — scheme:rest with no whitespace.
        if (/^[a-z][a-z0-9+.-]*:[^\s<>]+$/i.test(inside)) {
          const safeUrl = resolveDest(inside);
          flushText();
          segments.push({
            kind: "leaf",
            leaf: {
              kind: "autolink",
              openAngle: { from: i, to: i + 1 },
              content: { from: i + 1, to: closeAngle },
              closeAngle: { from: closeAngle, to: closeAngle + 1 },
              safeUrl,
            },
            span: { from: i, to: closeAngle + 1 },
          });
          i = closeAngle + 1;
          continue;
        }
      }
    }
    addChar(raw[i], i);
    i++;
  }
  flushText();
  return segments;
}

// Parse the IR from a raw cell string. The result is a lossless, DOM-free tree
// whose ordered leaf spans partition `raw` exactly (guaranteed by the tokenizer
// + resolveInline). PR2 uses this to map each span to a CodeMirror decoration.
export function parseCellInline(raw: string): Resolved<CellLeaf>[] {
  return resolveInline(tokenize(raw));
}

// Walk a Resolved<CellLeaf>[] and emit DOM nodes byte-identically to the
// previous direct-DOM tokenizer. A pending text buffer merges adjacent text
// values, escape unescaped chars, and inert-construct source slices into a
// single Text node (preserving the single-text-node topology that the
// renderReadonly topology tests pin). Flushed before every element node.
export function renderReadonly(ir: Resolved<CellLeaf>[], raw: string): Node[] {
  const out: Node[] = [];
  let pendingText = "";

  const flushPending = (): void => {
    if (pendingText.length > 0) {
      out.push(document.createTextNode(pendingText));
      pendingText = "";
    }
  };

  for (const node of ir) {
    switch (node.kind) {
      case "text":
        pendingText += node.value;
        break;
      case "leaf": {
        const leaf = node.leaf;
        switch (leaf.kind) {
          case "escape":
            // Merge the unescaped char into the pending-text buffer.
            pendingText += raw.slice(leaf.char.from, leaf.char.to);
            break;
          case "code": {
            flushPending();
            const el = document.createElement("code");
            el.textContent = raw.slice(leaf.content.from, leaf.content.to);
            out.push(el);
            break;
          }
          case "link":
            if (leaf.safeUrl !== null) {
              flushPending();
              const a = document.createElement("a");
              a.href = leaf.safeUrl;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.label.from, leaf.label.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              // Unsafe URL — merge the full source slice into pending text (inert).
              pendingText += raw.slice(node.span.from, node.span.to);
            }
            break;
          case "image":
            if (leaf.safeUrl !== null) {
              flushPending();
              const el = document.createElement("img");
              el.src = leaf.safeUrl;
              el.alt = commonMarkAltText(raw.slice(leaf.alt.from, leaf.alt.to));
              out.push(el);
            } else {
              pendingText += raw.slice(node.span.from, node.span.to);
            }
            break;
          case "autolink":
            if (leaf.safeUrl !== null) {
              flushPending();
              const a = document.createElement("a");
              a.href = leaf.safeUrl;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.content.from, leaf.content.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              pendingText += raw.slice(node.span.from, node.span.to);
            }
            break;
          default:
            assertNever(leaf);
        }
        break;
      }
      case "emphasis": {
        flushPending();
        const el = document.createElement(node.tag);
        for (const child of renderReadonly(node.children, raw)) {
          el.appendChild(child);
        }
        out.push(el);
        break;
      }
      default:
        assertNever(node);
    }
  }
  flushPending();
  return out;
}

export function renderCellInline(raw: string): Node[] {
  return renderReadonly(parseCellInline(raw), raw);
}

interface ParsedLink {
  label: string;
  url: string;
  /** Exclusive index of the `]` closing the label. */
  labelEnd: number;
  /** Exclusive index of the `)` closing the URL (= start of closeParen). */
  urlEnd: number;
  /** Exclusive index just past the closing `)`. */
  end: number;
}

// Parse `[label](url)` starting at `start` (the `[`). Returns null if the
// shape is broken; label / url may be empty strings. URL parse honours
// CommonMark §6.6 balanced parentheses (error-handler re-review Conf 82):
// a `(` opens a depth that a `)` must close before the unescaped `)` at
// depth 0 terminates the URL. Backslash-escaped chars are pass-through.
// This unbreaks links like `[Rust](https://en.wikipedia.org/wiki/Rust_(programming_language))`.
function tryParseLink(raw: string, start: number): ParsedLink | null {
  if (raw[start] !== "[") {
    return null;
  }
  const labelEnd = raw.indexOf("]", start + 1);
  if (labelEnd < 0) {
    return null;
  }
  if (raw[labelEnd + 1] !== "(") {
    return null;
  }
  let j = labelEnd + 2;
  let depth = 0;
  while (j < raw.length) {
    const c = raw[j];
    if (c === " " || c === "\t" || c === "\n" || c === "<" || c === ">") {
      return null;
    }
    if (c === "\\" && j + 1 < raw.length) {
      // Backslash escape — skip the escaped char so a `\)` does not close.
      j += 2;
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (depth === 0) {
        return {
          label: raw.slice(start + 1, labelEnd),
          url: raw.slice(labelEnd + 2, j),
          labelEnd,
          urlEnd: j,
          end: j + 1,
        };
      }
      depth--;
    }
    j++;
  }
  return null;
}

// `String.fromCodePoint` THROWS on lone surrogates (U+D800–U+DFFF). A
// crafted `&#xD800;` in a cell would crash the whole widget build and
// blank ALL widgets in the doc (Codex re-review Conf 90). We reject
// surrogates and out-of-range codepoints; the raw entity stays literal.
function safeFromCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code)) {
    return fallback;
  }
  if (code <= 0 || code > 0x10ffff) {
    return fallback;
  }
  if (code >= 0xd800 && code <= 0xdfff) {
    return fallback;
  }
  return String.fromCodePoint(code);
}

// ── CommonMark image-alt normalization ───────────────────────────────────────
// `<img alt>` and the blocked-image placeholder's `aria-label` need the
// CommonMark "string content" of the image label, NOT the raw source slice:
// backslash escapes resolved, character/entity references decoded, and inline
// formatting (emphasis, code, nested links/images, autolinks) flattened to its
// text. We reuse the cell inline IR parser (`parseCellInline`) — the same
// CommonMark §6.4 emphasis engine the table widget uses — and walk the IR to a
// string, rather than maintaining a second emphasis parser. Both the block
// image widget (`image/image-field.ts`) and this module's own `<img>` renderer
// call `commonMarkAltText`, so block-image and table-cell-image alt stay in
// lockstep. (Lives here, not in a neutral module, because it needs both
// `parseCellInline` and `CellLeaf` from this file — a separate module would
// create an import cycle; see plan doc.)

// Character/entity decode for DISPLAY text (alt), distinct from the URL-gate
// decoders: undecodable references stay LITERAL (NOT NUL) because alt is
// display text, never a security gate. Numeric references (decimal/hex) are
// decoded in full; named references cover a curated set of common display
// entities (the long tail is left to numeric refs, and an unknown named entity
// renders as its literal source — the safe, lossless choice for an alt
// attribute, never a full ~2125-entry HTML table). `&nbsp;` decodes to U+00A0
// (the real no-break space) to match what a CommonMark renderer produces.
const ALT_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

function decodeAltEntities(s: string): string {
  return s.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, entity: string) => {
      if (entity[0] === "#" && (entity[1] === "x" || entity[1] === "X")) {
        return safeFromCodePoint(Number.parseInt(entity.slice(2), 16), match);
      }
      if (entity[0] === "#") {
        return safeFromCodePoint(Number.parseInt(entity.slice(1), 10), match);
      }
      // Own-property check: a plain object inherits `constructor`, `toString`,
      // etc. from Object.prototype, so a bare `ALT_NAMED_ENTITIES[entity]` would
      // return those functions for `&constructor;` / `&toString;` and coerce
      // native source into the alt. Guarding keeps the "unknown entity stays
      // literal" invariant.
      return Object.hasOwn(ALT_NAMED_ENTITIES, entity) ? ALT_NAMED_ENTITIES[entity] : match;
    }
  );
}

// Walk the resolved inline IR to CommonMark string content. Text runs are
// entity-decoded; backslash escapes (already isolated as `escape` leaves by the
// tokenizer) contribute their literal char; code-span content is literal (no
// entity decode, per CommonMark); emphasis contributes its children flattened;
// nested links/images contribute their label/alt flattened recursively;
// autolinks contribute their literal URL text.
function flattenInlineText(ir: Resolved<CellLeaf>[], raw: string): string {
  let out = "";
  for (const node of ir) {
    switch (node.kind) {
      case "text":
        out += decodeAltEntities(node.value);
        break;
      case "emphasis":
        out += flattenInlineText(node.children, raw);
        break;
      case "leaf": {
        const leaf = node.leaf;
        switch (leaf.kind) {
          case "escape":
            out += raw.slice(leaf.char.from, leaf.char.to);
            break;
          case "code":
            out += raw.slice(leaf.content.from, leaf.content.to);
            break;
          case "link":
            out += commonMarkAltText(raw.slice(leaf.label.from, leaf.label.to));
            break;
          case "image":
            out += commonMarkAltText(raw.slice(leaf.alt.from, leaf.alt.to));
            break;
          case "autolink":
            out += raw.slice(leaf.content.from, leaf.content.to);
            break;
          default:
            assertNever(leaf);
        }
        break;
      }
      default:
        assertNever(node);
    }
  }
  return out;
}

export function commonMarkAltText(raw: string): string {
  if (raw === "") {
    return "";
  }
  return flattenInlineText(parseCellInline(raw), raw);
}
