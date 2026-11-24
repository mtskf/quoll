import { describe, expect, it } from "vitest";
import { applyEdits } from "../../../src/markdown/format/edit.js";
import { lineEdits } from "../../../src/markdown/format/line-planner.js";

const run = (s: string) => applyEdits(s, lineEdits(s, [], []));
// The range of the first `literal` occurrence in `s`.
const spanOf = (s: string, literal: string) => {
  const from = s.indexOf(literal);
  return { from, to: from + literal.length };
};

describe("lineEdits — trailing trim", () => {
  it("removes a single trailing space", () =>
    expect(run("hello \nworld\n")).toBe("hello\nworld\n"));
  it("preserves a two-space hard break on a content line", () =>
    expect(run("line one  \nline two\n")).toBe("line one  \nline two\n"));
  it("normalizes 3+ trailing spaces to a two-space hard break", () =>
    expect(run("line one    \nline two\n")).toBe("line one  \nline two\n"));
  it("removes trailing tabs (never a hard break)", () =>
    expect(run("code\t\t\nnext\n")).toBe("code\nnext\n"));
  it("trims a whitespace-only line to empty (NOT a hard break)", () =>
    expect(run("a\n  \nb\n")).toBe("a\n\nb\n"));
  it("preserves a tab-preceded hard break (run ENDS with 2 spaces)", () =>
    expect(run("foo\t  \nbar\n")).toBe("foo  \nbar\n"));
  it("trims a run that is 2 spaces then a tab (does NOT end in 2 spaces)", () =>
    expect(run("foo  \t\nbar\n")).toBe("foo\nbar\n"));
  it("leaves protected lines untouched", () =>
    expect(lineEdits("```\nlet a = 1   \n```\n", [{ from: 0, to: 15 }], [])).toEqual([]));
  it("keeps one space after an odd trailing backslash (trim would expose a hard break)", () =>
    expect(run("alpha\\ \nbeta\n")).toBe("alpha\\ \nbeta\n"));
  it("shrinks a longer run after an odd trailing backslash to one space", () =>
    expect(run("alpha\\ \t \nbeta\n")).toBe("alpha\\ \nbeta\n"));
  it("trims normally after an even (escaped) trailing backslash pair", () =>
    expect(run("alpha\\\\ \nbeta\n")).toBe("alpha\\\\\nbeta\n"));
  it("keeps a hard break after a trailing backslash unchanged", () =>
    expect(run("alpha\\  \nbeta\n")).toBe("alpha\\  \nbeta\n"));
});

describe("lineEdits — literal spans", () => {
  it("leaves a line end inside a literal span byte-identical", () => {
    const src = "a `x  \ny\t\nz` b  \nend   \n";
    const span = spanOf(src, "`x  \ny\t\nz`");
    expect(applyEdits(src, lineEdits(src, [], [span]))).toBe("a `x  \ny\t\nz` b  \nend  \n");
  });
  it("still trims a line whose run lies after the span closes", () => {
    const src = "a `x\ny`   \nb \n";
    const span = spanOf(src, "`x\ny`");
    expect(applyEdits(src, lineEdits(src, [], [span]))).toBe("a `x\ny`  \nb\n");
  });
});

describe("lineEdits — literal span scan cost", () => {
  // Counts element reads on the span list. A per-line rescan reads it
  // O(lines x spans) times; a forward cursor reads it O(lines + spans). Counting
  // reads is deterministic, unlike wall-clock timing under host load.
  it("reads the literal spans a linear number of times", () => {
    const n = 400;
    const src = "`a\nb` \n".repeat(n);
    const spans: { from: number; to: number }[] = [];
    for (let i = 0, at = 0; i < n; i++, at += 7) {
      spans.push({ from: at, to: at + 5 });
    }
    let reads = 0;
    const counted = new Proxy(spans, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads += 1;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const edits = lineEdits(src, [], counted);
    expect(edits).toEqual(lineEdits(src, [], [...spans]));
    expect(reads).toBeLessThan(10 * n);
  });
});

describe("lineEdits — keep-out ranges", () => {
  type R = { from: number; to: number };
  // Every non-blank line has trailing whitespace (so a trim edit) and the 3+ blank
  // runs trigger collapse edits, so a wrong skip flag on any line (protected or
  // editable) changes the edits.
  const src = "a \n\n\n\n  \nb  \n\t\nc   \n\n\n\nd \ne\t \n\n\n\nf  \ng \n";
  // The contract: a line is skipped iff it intersects ANY range. Expressed as one
  // sorted, disjoint, whole-line range per such line, which leaves no ordering,
  // overlap or partial-line case for the planner to get wrong.
  const perLine = (ranges: readonly R[]): R[] => {
    const out: R[] = [];
    for (let start = 0; start < src.length; ) {
      const end = src.indexOf("\n", start) + 1 || src.length;
      if (ranges.some((r) => r.from < end && start < r.to)) {
        out.push({ from: start, to: end });
      }
      start = end;
    }
    return out;
  };

  it("skips exactly the intersecting lines for unsorted, overlapping, nested and empty ranges", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let round = 0; round < 2000; round++) {
      const ranges: R[] = [];
      for (let k = rand(6); k > 0; k--) {
        const from = rand(src.length + 1);
        ranges.push({ from, to: Math.min(src.length, from + rand(14)) }); // 0 → empty
      }
      expect(lineEdits(src, ranges, [])).toEqual(lineEdits(src, perLine(ranges), []));
    }
  });

  // Counts field reads on the ranges. A per-line rescan reads them
  // O(lines x ranges) times; one sorted forward cursor reads them
  // O(lines + ranges log ranges). Deterministic, unlike wall-clock timing.
  it("reads the keep-out ranges a near-linear number of times", () => {
    const n = 2000;
    const table = "| a |\n| - |\n| b |\n\ntext \n\n";
    const doc = table.repeat(n);
    let reads = 0;
    const ranges: R[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const from = i * table.length;
      ranges.push(
        new Proxy(
          { from, to: from + 17 },
          {
            get(target, key, receiver) {
              reads += 1;
              return Reflect.get(target, key, receiver);
            },
          }
        )
      );
    }
    const edits = lineEdits(doc, ranges, []);
    expect(edits).toHaveLength(n); // one trim per "text " line
    expect(reads).toBeLessThan(60 * n);
  });
});

describe("lineEdits — blank collapse", () => {
  it("collapses a run of 3 blank lines to 1", () => expect(run("a\n\n\n\nb\n")).toBe("a\n\nb\n"));
  it("leaves a run of 2 blank lines untouched", () => expect(run("a\n\n\nb\n")).toBe("a\n\n\nb\n"));
  it("leaves a run of 1 blank line untouched", () => expect(run("a\n\nb\n")).toBe("a\n\nb\n"));
  it("is idempotent on many blanks", () => {
    const once = run("a\n\n\n\n\n\nb\n");
    expect(run(once)).toBe(once);
  });
});
