import { describe, expect, it } from "vitest";
import {
  parseCodeReference,
  parseInlineCodeReference,
} from "../../src/webview/cm/code-ref/parse-code-reference.js";

const inline = { requirePathSeparator: true } as const;

describe("parseCodeReference", () => {
  it("parses bare path, :line, :line:col (1-based)", () => {
    expect(parseCodeReference("src/foo.ts", inline)).toEqual({ path: "src/foo.ts" });
    expect(parseCodeReference("src/foo.ts:42", inline)).toEqual({ path: "src/foo.ts", line: 42 });
    expect(parseCodeReference("src/foo.ts:42:7", inline)).toEqual({
      path: "src/foo.ts",
      line: 42,
      col: 7,
    });
  });
  it("trims outer whitespace, rejects interior whitespace", () => {
    expect(parseCodeReference("  src/foo.ts:3  ", inline)).toEqual({ path: "src/foo.ts", line: 3 });
    expect(parseCodeReference("npm install foo", inline)).toBeNull();
  });
  it("rejects a no-separator token under the inline gate", () => {
    expect(parseCodeReference("useState", inline)).toBeNull();
    expect(parseCodeReference("object.property", inline)).toBeNull();
  });
  it("rejects scheme / absolute / backslash", () => {
    expect(parseCodeReference("http://x/y", { requirePathSeparator: false })).toBeNull();
    expect(parseCodeReference("/etc/passwd", inline)).toBeNull();
    expect(parseCodeReference("src\\foo.ts", inline)).toBeNull();
  });
  it("rejects out-of-range line numbers (parser/validator parity)", () => {
    expect(parseCodeReference("src/foo.ts:0", inline)).toBeNull();
    expect(parseCodeReference("src/foo.ts:99999999", inline)).toBeNull();
  });
  it("keeps non-numeric colons in the path", () => {
    expect(parseCodeReference("src/a:b/foo.ts", inline)).toEqual({ path: "src/a:b/foo.ts" });
  });
  it("documents the filename:number ambiguity (suffix wins — known v1 limitation)", () => {
    expect(parseCodeReference("src/a:2026", inline)).toEqual({ path: "src/a", line: 2026 });
  });
});

describe("parseInlineCodeReference", () => {
  it("accepts a path-shaped inline token", () => {
    expect(parseInlineCodeReference("src/foo.ts:42")).toEqual({ path: "src/foo.ts", line: 42 });
  });
  it("rejects a .md path (open-link's domain, not a dead affordance)", () => {
    expect(parseInlineCodeReference("docs/notes.md")).toBeNull();
  });
  it("rejects a token carrying a control byte", () => {
    expect(parseInlineCodeReference("src/f\u0001oo.ts")).toBeNull();
  });
});
