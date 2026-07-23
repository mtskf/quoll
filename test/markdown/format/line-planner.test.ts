import { describe, expect, it } from "vitest";
import { applyEdits } from "../../../src/markdown/format/edit.js";
import { lineEdits } from "../../../src/markdown/format/line-planner.js";

const run = (s: string) => applyEdits(s, lineEdits(s, []));

describe("lineEdits — trailing trim", () => {
  it("removes a single trailing space", () => expect(run("hello \nworld\n")).toBe("hello\nworld\n"));
  it("preserves a two-space hard break on a content line", () =>
    expect(run("line one  \nline two\n")).toBe("line one  \nline two\n"));
  it("normalizes 3+ trailing spaces to a two-space hard break", () =>
    expect(run("line one    \nline two\n")).toBe("line one  \nline two\n"));
  it("removes trailing tabs (never a hard break)", () =>
    expect(run("code\t\t\nnext\n")).toBe("code\nnext\n"));
  it("trims a whitespace-only line to empty (NOT a hard break)", () =>
    expect(run("a\n  \nb\n")).toBe("a\n\nb\n"));
  it("leaves protected lines untouched", () =>
    expect(lineEdits("```\nlet a = 1   \n```\n", [{ from: 0, to: 15 }])).toEqual([]));
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
