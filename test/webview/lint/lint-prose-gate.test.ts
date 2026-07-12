import { markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it, vi } from "vitest";
import { lintMarkdown, runRuleSafely } from "../../../src/webview/cm/lint/engine.js";
import type { LintContext, LintDiagnostic, LintRule } from "../../../src/webview/cm/lint/types.js";

const PROSE_CODES = new Set(["passive-voice", "filler-words", "long-sentence"]);
const proseCodes = (diags: readonly LintDiagnostic[]) =>
  diags.filter((d) => PROSE_CODES.has(d.code)).map((d) => d.code);

// A document that trips a prose rule (filler "very") AND a structural rule
// (trailing spaces), so both layers are observable at once.
const DOC = "This is very good.   \n";

describe("prose gate: quoll.lint.prose.enabled", () => {
  it("emits NO prose codes with the no-arg default", () => {
    expect(proseCodes(lintMarkdown(DOC))).toEqual([]);
  });

  it("emits NO prose codes with { prose: false }", () => {
    expect(proseCodes(lintMarkdown(DOC, { prose: false }))).toEqual([]);
  });

  it("emits prose codes with { prose: true }", () => {
    expect(proseCodes(lintMarkdown(DOC, { prose: true }))).toContain("filler-words");
  });

  it("keeps structural findings regardless of the prose flag", () => {
    const off = lintMarkdown(DOC).map((d) => d.code);
    const on = lintMarkdown(DOC, { prose: true }).map((d) => d.code);
    expect(off).toContain("no-trailing-spaces");
    expect(on).toContain("no-trailing-spaces");
  });
});

describe("prose rules: offset contract with leading frontmatter", () => {
  it("lands the diagnostic on the correct document bytes after the frontmatter shift", () => {
    // The engine slices the frontmatter off, runs body rules body-relative, then
    // re-adds bodyStart. A prose paragraph after the block must map back exactly.
    const doc = "---\ntitle: x\n---\n\nThis is very good.\n";
    const diags = lintMarkdown(doc, { prose: true }).filter((d) => d.code === "filler-words");
    expect(diags).toHaveLength(1);
    expect(doc.slice(diags[0]!.from, diags[0]!.to)).toBe("very");
  });
});

describe("prose precision: only Paragraph prose is scanned", () => {
  const proseCount = (doc: string) => proseCodes(lintMarkdown(doc, { prose: true })).length;

  it("ignores filler/passive words in a heading", () => {
    expect(proseCount("# just very actually\n")).toBe(0);
  });

  it("ignores them in a fenced code block", () => {
    expect(proseCount("```\njust very actually was written\n```\n")).toBe(0);
  });

  it("ignores them in a table cell", () => {
    expect(proseCount("| a | b |\n| - | - |\n| just | very |\n")).toBe(0);
  });

  it("ignores them in an inline-code span and a link URL", () => {
    expect(proseCount("text `just very` more\n")).toBe(0);
    expect(proseCount("see [x](http://just-very.example) end\n")).toBe(0);
  });

  it("DOES flag them in a plain, blockquote, and list-item paragraph", () => {
    expect(proseCount("This is very good.\n")).toBeGreaterThan(0);
    expect(proseCount("> This is very good.\n")).toBeGreaterThan(0);
    expect(proseCount("- This is very good.\n")).toBeGreaterThan(0);
  });
});

describe("per-rule isolation: runRuleSafely", () => {
  const ctx: LintContext = {
    text: "hello",
    tree: markdownLanguage.parser.parse("hello"),
  };

  it("returns [] when a rule throws, without propagating", () => {
    const boom: LintRule = () => {
      throw new Error("rule blew up");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runRuleSafely(boom, ctx)).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a throwing rule does not drop a good rule's findings when both run", () => {
    const good: LintRule = () => [
      { from: 0, to: 5, severity: "info", code: "filler-words", message: "ok" },
    ];
    const bad: LintRule = () => {
      throw new Error("nope");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = [good, bad].flatMap((r) => runRuleSafely(r, ctx));
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toBe("filler-words");
    spy.mockRestore();
  });
});
