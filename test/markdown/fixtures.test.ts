import { describe, expect, it } from "vitest";
import { CASE_HEADER_PATTERN, loadFixtures, MAX_FIXTURE_BYTES } from "./load-fixtures.js";

describe("markdown fixtures", () => {
  const fixtures = loadFixtures();

  it("loads at least the 11 documented case classes", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(11);
  });

  // Per Slice 2 acceptance criteria: every fixture must (a) carry a one-line
  // `<!-- case: ... -->` header so reviewers can scan intent, (b) stay under
  // 16 KiB so the corpus stays readable, and (c) expose a header-stripped
  // body that is non-empty, newline-terminated, and free of header remnants.
  it.each(fixtures)("$name: raw file starts with a case header", ({ raw }) => {
    expect(raw).toMatch(CASE_HEADER_PATTERN);
  });

  it.each(fixtures)("$name: raw file is under 16 KiB", ({ byteLength }) => {
    expect(byteLength).toBeLessThan(MAX_FIXTURE_BYTES);
  });

  it.each(
    fixtures
  )("$name: header-stripped source is non-empty, newline-terminated, and free of case-header remnants", ({
    source,
  }) => {
    expect(source.length).toBeGreaterThan(0);
    expect(source.endsWith("\n")).toBe(true);
    expect(source).not.toMatch(CASE_HEADER_PATTERN);
  });
});
