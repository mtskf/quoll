// Pins the runtime behaviour of `validateFrontmatter` (a boolean
// fence-safety predicate).
import { describe, expect, it } from "vitest";

import { validateFrontmatter } from "../../src/markdown/frontmatter.js";

describe("validateFrontmatter", () => {
  it("accepts a typical YAML body (LF)", () => {
    expect(validateFrontmatter("title: x\nauthor: y")).toBe(true);
  });

  it("accepts an empty string (canonical empty fence)", () => {
    expect(validateFrontmatter("")).toBe(true);
  });

  it("accepts indented or quoted dashes that are not a bare fence", () => {
    expect(validateFrontmatter("  ---\nkey: v")).toBe(true);
    expect(validateFrontmatter('key: "---"')).toBe(true);
    expect(validateFrontmatter("description: a --- b")).toBe(true);
  });

  it("accepts more than three dashes (only exactly `---` closes)", () => {
    expect(validateFrontmatter("----")).toBe(true);
    expect(validateFrontmatter("---a")).toBe(true);
    expect(validateFrontmatter("--- -")).toBe(true);
  });

  it("rejects a bare --- line with LF terminator", () => {
    expect(validateFrontmatter("title: x\n---\nfake")).toBe(false);
  });

  it("rejects a bare --- line with CRLF terminator", () => {
    expect(validateFrontmatter("title: x\r\n---\r\nfake")).toBe(false);
  });

  it("rejects a bare --- with trailing spaces/tabs", () => {
    expect(validateFrontmatter("title: x\n---  \nrest")).toBe(false);
    expect(validateFrontmatter("title: x\n---\t\nrest")).toBe(false);
  });

  it("rejects a bare --- as the only line", () => {
    expect(validateFrontmatter("---")).toBe(false);
  });
});
