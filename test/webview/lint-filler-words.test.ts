import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";

const filler = (doc: string) =>
  lintMarkdown(doc, { prose: true }).filter((d) => d.code === "filler-words");

describe("lint rule: filler-words", () => {
  it("flags a filler word as a whole word", () => {
    const doc = "This is very good.\n";
    const diags = filler(doc);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("info");
    expect(doc.slice(diags[0]!.from, diags[0]!.to)).toBe("very");
    expect(diags[0]!.message).toContain('"very"');
  });

  it("flags multiple fillers in one paragraph", () => {
    // "just" and "actually" are both in the list.
    expect(filler("I just actually agree.\n")).toHaveLength(2);
  });

  it("does not flag a substring match (justice contains just)", () => {
    expect(filler("Justice matters to everyone.\n")).toHaveLength(0);
  });

  it("matches case-insensitively", () => {
    expect(filler("Very interesting result.\n")).toHaveLength(1);
  });

  it("is off unless prose is enabled", () => {
    expect(lintMarkdown("This is very good.\n")).toHaveLength(0);
  });
});
