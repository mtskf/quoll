import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../../src/webview/cm/lint/engine.js";

const long = (doc: string) =>
  lintMarkdown(doc, { prose: true }).filter((d) => d.code === "long-sentence");

// Build a sentence of exactly `n` words followed by a period.
const sentence = (n: number) => `${Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ")}.`;

describe("lint rule: long-sentence", () => {
  it("flags a sentence longer than 30 words", () => {
    const doc = `${sentence(31)}\n`;
    const diags = long(doc);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("info");
    expect(diags[0]!.message).toContain("31 words");
  });

  it("does not flag a 10-word sentence", () => {
    expect(long(`${sentence(10)}\n`)).toHaveLength(0);
  });

  it("does not flag a sentence sitting exactly at the 30-word threshold", () => {
    expect(long(`${sentence(30)}\n`)).toHaveLength(0);
  });

  it("counts per sentence, not per paragraph", () => {
    // Two 20-word sentences in one paragraph: neither exceeds 30 on its own.
    const doc = `${sentence(20)} ${sentence(20)}\n`;
    expect(long(doc)).toHaveLength(0);
  });

  it("flags only the long sentence in a mixed paragraph, at the right byte range", () => {
    const doc = `${sentence(5)} ${sentence(31)}\n`;
    const diags = long(doc);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("31 words");
    // Pin the underline span: it must start AFTER the leading-space trim (at the
    // second sentence's first word), not at the space, and cover the full sentence.
    expect(doc.slice(diags[0]!.from, diags[0]!.to)).toBe(sentence(31));
  });

  it("is off unless prose is enabled", () => {
    expect(lintMarkdown(`${sentence(31)}\n`)).toHaveLength(0);
  });
});
