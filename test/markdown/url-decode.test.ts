import { describe, expect, it } from "vitest";
import { gfmParser } from "../../src/markdown/gfm-parser.js";
import { isAllowedUrl } from "../../src/markdown/url-allowlist.js";
import {
  decodeMarkdownDestination,
  encodeMarkdownDestination,
} from "../../src/markdown/url-decode.js";

/** The destination the SHIPPED parser extracts from `[t](dest)`, decoded the way
 *  every Quoll consumer decodes it. A regex cannot stand in for the parser here:
 *  it truncates at the first `)` of a parenthesised URL. Null when no link forms;
 *  an empty destination has no URL node and reads as "". */
function parsedDestination(dest: string): string | null {
  const md = `[t](${dest})`;
  let url = "";
  let seenUrl = false;
  let linkSpansAll = false;
  gfmParser.parse(md).iterate({
    enter: (n) => {
      if (n.name === "Link" && n.from === 0 && n.to === md.length) {
        linkSpansAll = true;
      }
      if (n.name === "URL" && !seenUrl) {
        seenUrl = true;
        url = md.slice(n.from, n.to);
      }
    },
  });
  return linkSpansAll ? decodeMarkdownDestination(url) : null;
}

// Deterministic PRNG (mulberry32) — a failing sample must reproduce on re-run.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("decodeMarkdownDestination (smoke — full attack matrix lives in lezer-url-walker.test.ts)", () => {
  it("strips surrounding angle brackets", () => {
    expect(decodeMarkdownDestination("<https://example.com>")).toBe("https://example.com");
  });

  it("undoes backslash escapes", () => {
    expect(decodeMarkdownDestination("javascript\\:alert(1)")).toBe("javascript:alert(1)");
  });

  it("decodes numeric character references", () => {
    expect(decodeMarkdownDestination("javascript&#58;alert(1)")).toBe("javascript:alert(1)");
  });

  it("decodes hex character references", () => {
    expect(decodeMarkdownDestination("javascript&#x3A;alert(1)")).toBe("javascript:alert(1)");
  });

  it("decodes URL-impactful named entities (case-insensitive)", () => {
    expect(decodeMarkdownDestination("javascript&colon;alert(1)")).toBe("javascript:alert(1)");
    expect(decodeMarkdownDestination("javascript&COLON;alert(1)")).toBe("javascript:alert(1)");
  });

  it("returns relative paths unchanged", () => {
    expect(decodeMarkdownDestination("/relative/path")).toBe("/relative/path");
    expect(decodeMarkdownDestination("#frag")).toBe("#frag");
  });

  it("returns http/https URLs unchanged when no escapes are present", () => {
    expect(decodeMarkdownDestination("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1"
    );
  });

  // Regression: NAMED_ENTITIES is a plain object literal, so a bare
  // `LOOKUP[name] ?? SUBSTITUTE` resolves `Object.prototype` member names
  // (`constructor` is the one that survives the `.toLowerCase()` fold) to the
  // inherited native function instead of failing closed — the function source
  // carries no `:` scheme, so isAllowedUrl would classify it as a relative
  // path and ALLOW it. The decoder must treat every unknown named entity —
  // prototype member names included — as undecodable and substitute NUL.
  it("decodes Object.prototype member-named entities to the NUL substitute, not inherited functions", () => {
    expect(decodeMarkdownDestination("&constructor;")).toBe("\u0000");
    expect(decodeMarkdownDestination("&CONSTRUCTOR;")).toBe("\u0000");
    expect(decodeMarkdownDestination("&toString;")).toBe("\u0000");
    expect(decodeMarkdownDestination("&valueOf;")).toBe("\u0000");
  });

  it("rejects a URL whose scheme is hidden behind an Object.prototype member-named entity", () => {
    const decoded = decodeMarkdownDestination("javascript&constructor;alert(1)");
    expect(isAllowedUrl(decoded)).toBe(false);
  });
});

describe("encodeMarkdownDestination", () => {
  it("leaves a plain URL untouched", () => {
    expect(encodeMarkdownDestination("https://x.com/a?b=1&c=2#f")).toBe(
      "https://x.com/a?b=1&c=2#f"
    );
  });

  it("escapes `&` only where the decoder would read a character reference", () => {
    expect(encodeMarkdownDestination("?a=1&amp;b=2")).toBe("?a=1&amp;amp;b=2");
    expect(encodeMarkdownDestination("?a=1&copy;")).toBe("?a=1&amp;copy;");
    expect(encodeMarkdownDestination("a&#58;b")).toBe("a&amp;#58;b");
    expect(encodeMarkdownDestination("a&#58x")).toBe("a&amp;#58x");
    expect(encodeMarkdownDestination("a&#X3a;b")).toBe("a&amp;#X3a;b");
    // Not reference-shaped to the decoder: a named run without `;`, a bare `&`.
    expect(encodeMarkdownDestination("?a=1&copy=2&lt=3&&")).toBe("?a=1&copy=2&lt=3&&");
  });

  it("doubles every backslash", () => {
    expect(encodeMarkdownDestination("a\\_b")).toBe("a\\\\_b");
    expect(encodeMarkdownDestination("a\\b")).toBe("a\\\\b");
  });

  it("writes angle brackets as references and wraps only for whitespace or parens", () => {
    expect(encodeMarkdownDestination("a<b>c")).toBe("a&lt;b&gt;c");
    expect(encodeMarkdownDestination("a b")).toBe("<a b>");
    expect(encodeMarkdownDestination("a(b)c")).toBe("<a(b)c>");
    expect(encodeMarkdownDestination("a b<c>d")).toBe("<a b&lt;c&gt;d>");
    expect(encodeMarkdownDestination("<a>")).toBe("&lt;a&gt;");
  });

  const cases = [
    "?a=1&amp;b=2",
    "&copy;",
    "&#58;",
    "&#58x",
    "&#x3A;&#0;&#xD800;",
    "&amp;amp;",
    "\\&amp;",
    "a\\_b",
    "a\\b",
    "a\\",
    "a\\<b",
    "a<b>",
    "<a>",
    "<a b>",
    "a (b) c",
    "a)b(c",
    "[x](y)",
    "日本語 &lt; ünï\u{1F600}",
    "",
  ];
  it.each(cases)("round-trips %j through the decoder and the shipped parser", (href) => {
    const enc = encodeMarkdownDestination(href);
    expect(decodeMarkdownDestination(enc)).toBe(href);
    expect(parsedDestination(enc)).toBe(href);
  });

  it("round-trips arbitrary hrefs (property)", () => {
    // Fragments chosen to collide: reference heads and tails, backslashes next to
    // punctuation and to the characters the encoder itself rewrites, both bracket
    // kinds, parens, whitespace, non-ASCII. CR/LF are excluded — the one documented
    // gap (no single-line destination form can carry them).
    const atoms = [
      "&",
      "&",
      "#",
      "#x",
      ";",
      ";",
      "amp",
      "lt",
      "gt",
      "copy",
      "colon",
      "58",
      "3A",
      "x",
      "\\",
      "\\",
      "_",
      ":",
      "/",
      "?",
      "=",
      ".",
      "-",
      "!",
      "*",
      "`",
      '"',
      "'",
      "~",
      "|",
      "<",
      ">",
      "[",
      "]",
      "(",
      ")",
      " ",
      "\t",
      "a",
      "Z",
      "0",
      "é",
      "日",
      "\u{1F600}",
      "\u00a0",
    ];
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < 20000; i++) {
      const len = Math.floor(rand() * 12);
      let href = "";
      for (let j = 0; j < len; j++) {
        href += atoms[Math.floor(rand() * atoms.length)];
      }
      const enc = encodeMarkdownDestination(href);
      const decoded = decodeMarkdownDestination(enc);
      const parsed = parsedDestination(enc);
      if (decoded !== href || parsed !== href) {
        // Report the sample, not a bare boolean.
        expect({ href, enc, decoded, parsed }).toEqual({
          href,
          enc,
          decoded: href,
          parsed: href,
        });
      }
    }
  });
});
