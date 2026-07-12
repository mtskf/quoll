import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../../src/webview/cm/lint/engine.js";

const passive = (doc: string) =>
  lintMarkdown(doc, { prose: true }).filter((d) => d.code === "passive-voice");

describe("lint rule: passive-voice", () => {
  it("flags a be-form + -ed participle", () => {
    const doc = "The report was written by the team.\n";
    const diags = passive(doc);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("info");
    expect(doc.slice(diags[0]!.from, diags[0]!.to)).toBe("was written");
  });

  it("flags a progressive passive at the being+participle core", () => {
    // write-good-style: the passive is caught at "being reviewed" (a be-form
    // followed by a participle); the leading auxiliary "is" is not part of the span.
    const doc = "The change is being reviewed now.\n";
    const diags = passive(doc);
    expect(diags).toHaveLength(1);
    expect(doc.slice(diags[0]!.from, diags[0]!.to)).toBe("being reviewed");
  });

  it("flags an irregular participle (were made)", () => {
    expect(passive("Mistakes were made here.\n")).toHaveLength(1);
  });

  it("does not flag active voice", () => {
    expect(passive("She wrote the report yesterday.\n")).toHaveLength(0);
  });

  it("is off unless prose is enabled", () => {
    expect(lintMarkdown("The report was written.\n")).toHaveLength(0);
  });
});
