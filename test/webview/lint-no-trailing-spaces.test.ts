import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";

const trailingDiags = (doc: string) =>
  lintMarkdown(doc).filter((d) => d.code === "no-trailing-spaces");

describe("lint rule: no-trailing-spaces", () => {
  it("flags a single trailing space after content", () => {
    const doc = "foo \nbar\n"; // "foo " has one trailing space
    const diags = trailingDiags(doc);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    expect(d.from).toBe(3); // just after "foo"
    expect(d.to).toBe(4); // end of "foo " content, before the "\n"
    expect(doc.slice(d.from, d.to)).toBe(" ");
  });

  it("flags three or more trailing spaces", () => {
    expect(trailingDiags("foo   \n")).toHaveLength(1);
  });

  it("does NOT flag exactly two trailing spaces on a terminated line (hard break)", () => {
    expect(trailingDiags("foo  \nbar\n")).toHaveLength(0);
  });

  // Hard-break policy (decided 2026-06-27): only the canonical exactly-two form
  // is exempt. A 3+-space run is a CommonMark-valid but non-idiomatic break that
  // we deliberately treat as ACCIDENTAL — flagged even on a terminated line that
  // has somewhere to break to. Pins option (a) over (b) "exempt all >=2-space
  // breaks". See SPEC.md / LEARNING.md.
  it("DOES flag three trailing spaces on a terminated line (non-idiomatic hard break treated as accidental)", () => {
    const diags = trailingDiags("foo   \nbar\n");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.from).toBe(3);
    expect(diags[0]!.to).toBe(6); // covers all three spaces, before the "\n"
    // Policy (a) full-removal, NOT trim-to-two: the fix deletes the whole run
    // (insert ""), even on a terminated line that has somewhere to break to.
    expect(diags[0]!.fix).toEqual({ from: 3, to: 6, insert: "" });
  });

  it("DOES flag two trailing spaces at EOF (no terminator -> not a hard break)", () => {
    const diags = trailingDiags("foo  "); // two spaces, no final newline
    expect(diags).toHaveLength(1);
    expect(diags[0]!.from).toBe(3);
    expect(diags[0]!.to).toBe(5);
  });

  it("flags a trailing tab", () => {
    expect(trailingDiags("foo\t\n")).toHaveLength(1);
  });

  it("does NOT flag whitespace-only (blank) lines", () => {
    expect(trailingDiags("foo\n   \nbar\n")).toHaveLength(0);
  });

  it("does NOT flag a clean line", () => {
    expect(trailingDiags("foo\nbar\n")).toHaveLength(0);
  });

  it("flags a trailing space before a CRLF line ending", () => {
    const diags = trailingDiags("foo \r\nbar\r\n");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.from).toBe(3);
    expect(diags[0]!.to).toBe(4); // covers the space, before the "\r"
  });

  it("flags a trailing space before a lone-CR line ending", () => {
    const diags = trailingDiags("foo \rbar\r");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.from).toBe(3);
    expect(diags[0]!.to).toBe(4);
  });
});

describe("lint rule: no-trailing-spaces — fix descriptor", () => {
  it("carries a delete-the-whitespace fix matching the diagnostic range", () => {
    const doc = "foo \nbar\n";
    const d = trailingDiags(doc)[0]!;
    expect(d.fix).toEqual({ from: d.from, to: d.to, insert: "" });
    // Byte-diff: applying the fix yields the trimmed bytes.
    const fixed = doc.slice(0, d.fix!.from) + d.fix!.insert + doc.slice(d.fix!.to);
    expect(fixed).toBe("foo\nbar\n");
  });

  it("fixes multiple trailing spaces (whole run deleted)", () => {
    const doc = "foo   \n";
    const d = trailingDiags(doc)[0]!;
    expect(d.fix).toEqual({ from: 3, to: 6, insert: "" });
    expect(doc.slice(0, d.fix!.from) + d.fix!.insert + doc.slice(d.fix!.to)).toBe("foo\n");
  });

  it("fixes a trailing tab", () => {
    const doc = "foo\t\n";
    const d = trailingDiags(doc)[0]!;
    expect(d.fix).toEqual({ from: 3, to: 4, insert: "" });
    expect(doc.slice(0, d.fix!.from) + d.fix!.insert + doc.slice(d.fix!.to)).toBe("foo\n");
  });

  it("fixes two trailing spaces at EOF (no terminator)", () => {
    const doc = "foo  ";
    const d = trailingDiags(doc)[0]!;
    expect(d.fix).toEqual({ from: 3, to: 5, insert: "" });
    expect(doc.slice(0, d.fix!.from) + d.fix!.insert + doc.slice(d.fix!.to)).toBe("foo");
  });
});

describe("lint rule: heading-increment — no fix", () => {
  it("does not populate a fix descriptor", () => {
    const diags = lintMarkdown("# Title\n\n### Skip\n").filter(
      (d) => d.code === "heading-increment"
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.fix === undefined)).toBe(true);
  });
});
