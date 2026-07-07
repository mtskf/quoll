import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { frontmatterContentLines } from "../../src/webview/cm/lint/frontmatter-range.js";
import { scanLines } from "../../src/webview/cm/lint/line-scan.js";
import { frontmatterStructure } from "../../src/webview/cm/lint/rules/frontmatter-structure.js";

describe("frontmatterContentLines", () => {
  it("returns the lines strictly between the fences, with absolute offsets", () => {
    const block = "---\ntitle: a\ntags: b\n---\n";
    const lines = frontmatterContentLines(block);
    expect(lines.map((l) => l.content)).toEqual(["title: a", "tags: b"]);
    // "---\n" is 4 chars, so "title: a" starts at offset 4.
    expect(lines[0]!.from).toBe(4);
    expect(block.slice(lines[0]!.from, lines[0]!.from + lines[0]!.content.length)).toBe("title: a");
  });

  it("returns [] for an empty frontmatter block (opener immediately closed)", () => {
    expect(frontmatterContentLines("---\n---\n")).toEqual([]);
  });

  it("excludes the closing fence line itself", () => {
    const lines = frontmatterContentLines("---\nk: 1\n---\n");
    expect(lines.map((l) => l.content)).toEqual(["k: 1"]);
  });

  it("handles a CRLF block (terminators stripped, offsets absolute)", () => {
    const block = "---\r\nk: 1\r\n---\r\n";
    const lines = frontmatterContentLines(block);
    expect(lines.map((l) => l.content)).toEqual(["k: 1"]);
    // "---\r\n" is 5 chars, so "k: 1" starts at offset 5; the span excludes the CRLF.
    expect(lines[0]!.from).toBe(5);
    expect(block.slice(lines[0]!.from, lines[0]!.from + lines[0]!.content.length)).toBe("k: 1");
  });
});

// Build a context from the CONTENT string (the lines between fences only). The
// rule is fence-agnostic, so tests feed it content directly; offsets are relative
// to `content` here (== absolute in production, where content starts at offset 0).
const runRule = (content: string) => frontmatterStructure({ contentLines: scanLines(content) });
const dup = (c: string) => runRule(c).filter((d) => d.code === "frontmatter-duplicate-key");
const malformed = (c: string) => runRule(c).filter((d) => d.code === "frontmatter-malformed-line");

describe("lint rule: frontmatter-structure", () => {
  it("flags the second occurrence of a duplicated top-level key", () => {
    const c = "title: a\ntitle: b\n";
    const diags = dup(c);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("warning");
    expect(c.slice(diags[0]!.from, diags[0]!.to)).toBe("title: b"); // the SECOND
  });

  it("flags every later occurrence (3x key -> 2 findings)", () => {
    expect(dup("k: 1\nk: 2\nk: 3\n")).toHaveLength(2);
  });

  it("does not flag distinct top-level keys", () => {
    expect(dup("title: a\ntags: b\ndate: c\n")).toHaveLength(0);
  });

  it("does not treat a nested (indented) repeated key as a top-level duplicate", () => {
    expect(dup("a:\n  id: 1\nb:\n  id: 2\n")).toHaveLength(0);
  });

  it("compares keys literally: quoted and unquoted keys are NOT unified", () => {
    // `"title"` and `title` are distinct literal keys (no YAML parse / unquoting).
    expect(dup('"title": a\ntitle: b\n')).toHaveLength(0);
  });

  it("flags a duplicate of two identically-quoted keys", () => {
    expect(dup('"title": a\n"title": b\n')).toHaveLength(1);
  });

  it("uses a parser-independent duplicate message (no `overrides`)", () => {
    const d = dup("k: 1\nk: 2\n")[0]!;
    expect(d.message).not.toContain("overrides");
    expect(d.message).toContain("duplicates an earlier key");
  });

  it("flags a structurally malformed col-0 line (no colon, not a list item)", () => {
    const c = "title: a\nthis is not valid\n";
    const diags = malformed(c);
    expect(diags).toHaveLength(1);
    expect(c.slice(diags[0]!.from, diags[0]!.to)).toBe("this is not valid");
  });

  it("flags `key:value` (no space after colon — not a YAML mapping entry)", () => {
    expect(malformed("title:a\n")).toHaveLength(1);
  });

  it("accepts `key:` (empty value) and `key: value`", () => {
    expect(malformed("empty:\nfilled: x\n")).toHaveLength(0);
  });

  it("does not flag a well-formed block (keys, nested mapping, list items, blanks, comments)", () => {
    const c = "title: a\n# a comment\ntags:\n  - one\n  - two\nmeta:\n  nested: x\n\ndate: c\n";
    expect(malformed(c)).toHaveLength(0);
    expect(dup(c)).toHaveLength(0);
  });

  it("accepts a top-level list item line (`- item`)", () => {
    expect(malformed("- one\n- two\n")).toHaveLength(0);
  });
});

// Pins the TODO's explicit layer constraint: the RULE must not reach into the
// host-side frontmatter model. lint-independence.test.ts only guards the
// write-gate modules, so this guards the `src/markdown/` boundary directly.
describe("frontmatter-structure rule is independent of the host frontmatter model", () => {
  it("imports nothing from markdown/", () => {
    const src = readFileSync(
      new URL("../../src/webview/cm/lint/rules/frontmatter-structure.ts", import.meta.url),
      "utf8"
    );
    for (const m of src.matchAll(/^\s*import\s[^;]*?["']([^"']+)["']/gm)) {
      expect(m[1]).not.toMatch(/markdown/);
    }
  });
});
