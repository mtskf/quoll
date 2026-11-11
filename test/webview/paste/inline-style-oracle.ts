// Re-parse oracle for pasted emphasis: does the Markdown the converter wrote,
// read back by the editor's own parser (Lezer, via `gfmParser`), style the same
// characters the source HTML styled? The contract is decision 7 of
// .claude/plans/2026-11-11-paste-02b-pr1-inline-style-runs.md.
//
// Deliberately independent of the converter: it reads the HTML with its own DOM
// walk and the Markdown with the parser, and shares no code with either side of
// the conversion except the StyleMask bits.
import type { SyntaxNode } from "@lezer/common";
import { gfmParser } from "../../../src/markdown/gfm-parser.js";
import { BOLD, ITALIC, type StyleMask } from "../../../src/webview/cm/paste/inline-runs.js";

export interface StyledChar {
  ch: string;
  style: StyleMask;
}

const INVISIBLE = /^(?:\p{Default_Ignorable_Code_Point}|\p{Cf})$/u;
const WHITESPACE = /^\s$/;
// Lezer 1.6.4's punctuation class (`Emphasis()` in @lezer/markdown), tested on one
// UTF-16 code unit as the parser does — so an astral char is a word char.
const PUNCTUATION = /[\p{S}|\p{P}]/u;

type CharClass = "word" | "space" | "punct";

function classify(ch: string): CharClass {
  if (WHITESPACE.test(ch)) {
    return "space";
  }
  return PUNCTUATION.test(ch[0]) ? "punct" : "word";
}

function pushChars(out: StyledChar[], text: string, style: StyleMask): void {
  for (const ch of text) {
    out.push({ ch, style });
  }
}

/** Drop the invisible format chars, then the whitespace records at both edges. */
function normalise(chars: StyledChar[]): StyledChar[] {
  const visible = chars.filter((c) => !INVISIBLE.test(c.ch));
  let start = 0;
  let end = visible.length;
  while (start < end && WHITESPACE.test(visible[start].ch)) {
    start++;
  }
  while (end > start && WHITESPACE.test(visible[end - 1].ch)) {
    end--;
  }
  return visible.slice(start, end);
}

// Copied from `EMPHASIS_CANCELLED_BY` in src/webview/cm/paste/html-to-markdown.ts
// (not imported, so the oracle does not share the decision it checks). Keep in sync.
const CANCELS_BOLD = /(?:^|;)\s*font-weight\s*:\s*(?:normal|400)\b/i;
const CANCELS_ITALIC = /(?:^|;)\s*font-style\s*:\s*normal\b/i;

const SKIPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);

/** The source's styled chars. Whitespace is collapsed PER TEXT NODE (remove
 *  U+200B / U+FEFF, then each `\s+` → one space), never across nodes. */
export function htmlStyledChars(html: string): StyledChar[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: StyledChar[] = [];
  const walk = (node: Node, style: StyleMask): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ");
      pushChars(out, text, style);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el = node as Element;
    if (SKIPPED.has(el.tagName)) {
      return;
    }
    const css = el.getAttribute("style") ?? "";
    let own = style;
    if ((el.tagName === "B" || el.tagName === "STRONG") && !CANCELS_BOLD.test(css)) {
      own = (own | BOLD) as StyleMask;
    }
    if ((el.tagName === "I" || el.tagName === "EM") && !CANCELS_ITALIC.test(css)) {
      own = (own | ITALIC) as StyleMask;
    }
    for (const child of Array.from(el.childNodes)) {
      walk(child, own);
    }
  };
  walk(doc.body, 0);
  return normalise(out);
}

const SKIPPED_NODES = new Set([
  "EmphasisMark",
  "HeaderMark",
  "HardBreak",
  "LinkMark",
  "URL",
  "CodeMark",
]);

function decodeEntity(raw: string): string {
  const m = /^&#(?:x([0-9a-f]+)|([0-9]+));$/i.exec(raw);
  if (m === null) {
    return raw;
  }
  return String.fromCodePoint(m[1] !== undefined ? Number.parseInt(m[1], 16) : Number(m[2]));
}

/** The Markdown's styled chars as Lezer reads them, from the first paragraph or
 *  ATX heading: StrongEmphasis → BOLD, Emphasis → ITALIC, link label chars keep
 *  the surrounding style; syntax marks are skipped, an Escape is its escaped char
 *  and an Entity its decoded numeric reference. */
export function markdownStyledChars(md: string): StyledChar[] {
  const tree = gfmParser.parse(md);
  let block: SyntaxNode | null = tree.topNode.firstChild;
  while (block !== null && block.name !== "Paragraph" && !block.name.startsWith("ATXHeading")) {
    block = block.nextSibling;
  }
  const out: StyledChar[] = [];
  if (block === null) {
    return out;
  }
  const walk = (node: SyntaxNode, style: StyleMask): void => {
    let pos = node.from;
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      pushChars(out, md.slice(pos, child.from), style);
      pos = child.to;
      if (SKIPPED_NODES.has(child.name)) {
        continue;
      }
      if (child.name === "Escape") {
        pushChars(out, md.slice(child.from + 1, child.to), style);
      } else if (child.name === "Entity") {
        pushChars(out, decodeEntity(md.slice(child.from, child.to)), style);
      } else if (child.name === "StrongEmphasis") {
        walk(child, (style | BOLD) as StyleMask);
      } else if (child.name === "Emphasis") {
        walk(child, (style | ITALIC) as StyleMask);
      } else {
        walk(child, style);
      }
    }
    pushChars(out, md.slice(pos, node.to), style);
  };
  walk(block, 0);
  return normalise(out);
}

/** Start index of the maximal run of chars carrying `s` that contains `i`. */
function runStart(chars: readonly StyledChar[], i: number, s: StyleMask): number {
  let j = i;
  while (j > 0 && chars[j - 1].style & s) {
    j--;
  }
  return j;
}

/** May punctuation char `p` (index `i`) have lost style `s`? Only when demotion
 *  was forced: walking outward through adjacent punctuation that carries `s`, the
 *  first char reached is a word char `w` such that (i) `w` lacks `s`, or (ii) some
 *  style `t` carried by exactly one of `p`/`w` closes there and its run began
 *  strictly before `s`'s run at that same char (so `t` encloses `s`). */
function dropForced(chars: readonly StyledChar[], i: number, s: StyleMask): boolean {
  const p = chars[i];
  for (const step of [-1, 1]) {
    let j = i + step;
    while (j >= 0 && j < chars.length && classify(chars[j].ch) === "punct" && chars[j].style & s) {
      j += step;
    }
    if (j < 0 || j >= chars.length || classify(chars[j].ch) !== "word") {
      continue; // a string edge or whitespace: no drop allowed this way
    }
    const w = chars[j];
    if (!(w.style & s)) {
      return true; // (i)
    }
    for (const t of [BOLD, ITALIC] as const) {
      const onP = Boolean(p.style & t);
      if (t === s || onP === Boolean(w.style & t)) {
        continue;
      }
      const at = onP ? i : j;
      if (runStart(chars, at, t) < runStart(chars, at, s)) {
        return true; // (ii)
      }
    }
  }
  return false;
}

const show = (chars: readonly StyledChar[]): string =>
  chars.map((c) => `${c.ch}:${c.style}`).join(" ");

/** Throw unless `md`, re-parsed, styles the same chars as `html` (decision 7). */
export function assertStyleParity(html: string, md: string): void {
  const src = htmlStyledChars(html);
  const got = markdownStyledChars(md);
  const fail = (why: string): never => {
    throw new Error(`style parity: ${why}\n  html: ${show(src)}\n  md:   ${show(got)}`);
  };
  if (src.map((c) => c.ch).join("") !== got.map((c) => c.ch).join("")) {
    fail("text differs");
  }
  src.forEach((h, i) => {
    const m = got[i];
    switch (classify(h.ch)) {
      case "word":
        if (m.style !== h.style) {
          fail(`word char ${i} restyled`);
        }
        return;
      case "space":
        if (m.style & ~h.style) {
          fail(`space ${i} gained a style`);
        }
        return;
      case "punct": {
        if (m.style & ~h.style) {
          fail(`punctuation ${i} gained a style`);
        }
        for (const s of [BOLD, ITALIC] as const) {
          if (h.style & s && !(m.style & s) && !dropForced(src, i, s)) {
            fail(`punctuation ${i} lost style ${s} without a forced demotion`);
          }
        }
      }
    }
  });
}
