import { describe, expect, it } from "vitest";
import { minimalEditSpan } from "../../../src/extension/session/minimal-edit.js";

const apply = (old: string, s: { from: number; to: number; insert: string }) =>
  old.slice(0, s.from) + s.insert + old.slice(s.to);

describe("minimalEditSpan", () => {
  const cases: Array<[string, string, string]> = [
    ["mid insert", "hello world", "hello brave world"],
    ["mid delete", "hello brave world", "hello world"],
    ["mid replace", "the quick fox", "the slow fox"],
    ["prepend", "world", "hello world"],
    ["append", "hello", "hello world"],
    ["empty -> nonempty", "", "abc"],
    ["nonempty -> empty", "abc", ""],
    ["no-op", "same", "same"],
    ["CRLF content", "a\r\nb\r\nc", "a\r\nB\r\nc"],
    ["emoji (surrogate) replace", "x😀y", "x😁y"],
    ["shared prefix and suffix", "aXXXb", "aYb"],
  ];
  for (const [name, oldText, newText] of cases) {
    it(`reproduces newText: ${name}`, () => {
      const span = minimalEditSpan(oldText, newText);
      expect(apply(oldText, span)).toBe(newText);
    });
  }

  it("excludes the shared prefix and suffix (minimal for single-region edit)", () => {
    const span = minimalEditSpan("hello world", "hello brave world");
    expect(span.from).toBe(6); // after "hello "
    expect(span.insert).toBe("brave ");
    expect(span.to).toBe(6); // pure insertion: zero-width range
  });

  it("returns a zero-width no-op span when texts are equal", () => {
    const span = minimalEditSpan("same", "same");
    expect(span.from).toBe(span.to);
    expect(span.insert).toBe("");
  });
});

describe("minimalEditSpan — never splits a CRLF pair (EOL normalization safety)", () => {
  // A boundary index k bisects a CRLF iff s[k-1] is CR and s[k] is LF.
  const bisects = (s: string, k: number) =>
    k > 0 && k < s.length && s.charCodeAt(k - 1) === 13 && s.charCodeAt(k) === 10;

  // EOL-mismatch inputs: old and new disagree on EOL, so a naive prefix/suffix
  // trim can land a span boundary between a CR and its following LF. VS Code
  // normalizes the EOL of inserted text per-edit, so isolating a lone \r/\n
  // would diverge from a whole-document replace. The snap must widen the span.
  const eolCases: Array<[string, string, string]> = [
    ["LF -> CRLF (single line)", "a\nb", "a\r\nb"],
    ["CRLF -> LF (single line)", "a\r\nb", "a\nb"],
    ["LF -> CRLF (multi line)", "x\ny\nz", "x\r\ny\r\nz"],
    ["CRLF -> LF (multi line)", "a\r\nb\r\nc", "a\nb\nc"],
    ["LF -> CRLF (trailing newline)", "line\n", "line\r\n"],
  ];
  for (const [name, oldText, newText] of eolCases) {
    it(`reproduces newText and keeps CRLF pairs intact: ${name}`, () => {
      const span = minimalEditSpan(oldText, newText);
      // (a) String equivalence with whole-document replace.
      expect(apply(oldText, span)).toBe(newText);
      // (b) No boundary bisects a CRLF in either string. The new-side suffix
      //     boundary is newLen - (oldLen - span.to).
      const newSufBoundary = newText.length - (oldText.length - span.to);
      expect(bisects(oldText, span.from)).toBe(false);
      expect(bisects(oldText, span.to)).toBe(false);
      expect(bisects(newText, span.from)).toBe(false);
      expect(bisects(newText, newSufBoundary)).toBe(false);
    });
  }

  it("is inert for same-EOL inputs (snap does not widen the span)", () => {
    const span = minimalEditSpan("hello world", "hello brave world");
    expect(span).toEqual({ from: 6, to: 6, insert: "brave " });
  });

  it("is inert for a same-EOL CRLF replace (snap does not widen the span)", () => {
    const span = minimalEditSpan("a\r\nb\r\nc", "a\r\nB\r\nc");
    expect(apply("a\r\nb\r\nc", span)).toBe("a\r\nB\r\nc");
    expect(span).toEqual({ from: 3, to: 4, insert: "B" });
  });
});

describe("minimalEditSpan property — reproduces whole-document replace", () => {
  // mulberry32: deterministic seeded PRNG (no Math.random; reproducible CI).
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = ["a", "b", " ", "\n", "\r\n", "😀", "é", "#", "|"];
  const randString = (r: () => number, maxLen: number) => {
    const len = Math.floor(r() * maxLen);
    let s = "";
    for (let i = 0; i < len; i++) {
      s += alphabet[Math.floor(r() * alphabet.length)];
    }
    return s;
  };
  const apply = (old: string, s: { from: number; to: number; insert: string }) =>
    old.slice(0, s.from) + s.insert + old.slice(s.to);

  it("reproduces newText for 2000 random (base, edited) pairs", () => {
    const r = rng(0x9e3779b9);
    for (let i = 0; i < 2000; i++) {
      const base = randString(r, 200);
      // Build `edited` by applying a random insert/delete/replace at a random
      // position — the same class of change a debounced flush emits.
      const from = Math.floor(r() * (base.length + 1));
      const to = from + Math.floor(r() * (base.length - from + 1));
      const insert = randString(r, 30);
      const edited = base.slice(0, from) + insert + base.slice(to);

      const span = minimalEditSpan(base, edited);
      expect(apply(base, span)).toBe(edited); // === whole-document replace result
      // Minimality: the span excludes any shared boundary chars.
      if (span.from < span.to || span.insert.length > 0) {
        expect(base.slice(0, span.from)).toBe(edited.slice(0, span.from));
      }
    }
  });
});
