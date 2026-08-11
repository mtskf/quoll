// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { findHeadingBySlug } from "../../src/webview/cm/link-resolve.js";

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

function lookup(doc: string, slug: string): number | null {
  const state = stateOf(doc);
  return findHeadingBySlug(state, syntaxTree(state), slug);
}

function lineStartOf(doc: string, needle: string): number {
  const i = doc.indexOf(needle);
  if (i < 0) {
    throw new Error(`needle not in doc: ${needle}`);
  }
  return doc.lastIndexOf("\n", i) + 1;
}

describe("findHeadingBySlug", () => {
  it("resolves a slug to the heading's line start", () => {
    const doc = "intro\n\n## Getting Started\n\nbody\n";
    expect(lookup(doc, "getting-started")).toBe(lineStartOf(doc, "## Getting"));
  });

  it("returns null for a slug no heading produces", () => {
    expect(lookup("# One\n\ntext\n", "two")).toBeNull();
  });

  it("gives duplicate heading text GitHub-style -1 / -2 suffixes in document order", () => {
    const doc = "# Notes\n\na\n\n# Notes\n\nb\n\n# Notes\n\nc\n";
    expect(lookup(doc, "notes")).toBe(0);
    expect(lookup(doc, "notes-1")).toBe(doc.indexOf("# Notes", 1));
    expect(lookup(doc, "notes-2")).toBe(doc.lastIndexOf("# Notes"));
  });

  it("steps past a suffix a literal heading already claimed", () => {
    // `# A`, `# A-1`, `# A` — the third heading wants `a-1`, which the SECOND
    // heading already owns, so it must land on `a-2`. A naive per-base counter
    // would compute `a-1`, find it taken, and drop the third heading entirely
    // (unreachable by any slug). github-slugger increments until free.
    const doc = "# A\n\nx\n\n# A-1\n\ny\n\n# A\n\nz\n";
    expect(lookup(doc, "a")).toBe(0);
    expect(lookup(doc, "a-1")).toBe(doc.indexOf("# A-1"));
    expect(lookup(doc, "a-2")).toBe(doc.lastIndexOf("# A"));
  });

  it("finds a heading nested in a blockquote, anchored at the container line start", () => {
    const doc = "text\n\n> ## Quoted Heading\n\nmore\n";
    expect(lookup(doc, "quoted-heading")).toBe(lineStartOf(doc, "> ## Quoted"));
  });

  it("ignores a `#` line inside a fenced code block", () => {
    const doc = "text\n\n```\n# Not A Heading\n```\n";
    expect(lookup(doc, "not-a-heading")).toBeNull();
  });

  it("skips a heading whose text slugs to nothing", () => {
    expect(lookup("#\n\ntext\n", "")).toBeNull();
    expect(lookup("# !!!\n\ntext\n", "")).toBeNull();
  });

  it("re-resolves against an edited document instead of serving a stale offset", () => {
    const before = stateOf("# Alpha\n\nbody\n");
    expect(findHeadingBySlug(before, syntaxTree(before), "alpha")).toBe(0);
    const after = before.update({ changes: { from: 0, insert: "lead-in\n\n" } }).state;
    expect(findHeadingBySlug(after, syntaxTree(after), "alpha")).toBe("lead-in\n\n".length);
  });

  it("rebuilds when the SAME tree is handed a different document", () => {
    // This is the assertion that actually exercises the cache guard, and it has
    // to reuse the tree OBJECT to do it: an ordinary edit produces a new Tree,
    // so the WeakMap key changes and any guard would look correct (measured —
    // `# Alpha` → `# Gamma` yields a different Text AND a different Tree). Pass
    // the stale tree with the new state and the key collides, which is exactly
    // the case a docLength guard cannot see: same length, dead `alpha` entry
    // served forever. Identity on `state.doc` catches it.
    const before = stateOf("# Alpha\n\nbody\n");
    const tree = syntaxTree(before);
    expect(findHeadingBySlug(before, tree, "alpha")).toBe(0);
    const after = before.update({ changes: { from: 2, to: 7, insert: "Gamma" } }).state;
    expect(after.doc.length).toBe(before.doc.length);
    expect(findHeadingBySlug(after, tree, "alpha")).toBeNull();
    expect(findHeadingBySlug(after, tree, "gamma")).toBe(0);
  });

  it("cannot see a heading beyond a PARTIAL tree (the premise Task 3's budget answers)", () => {
    // Non-vacuity guard for design decision 2: prove a bounded tree really can
    // miss a far heading, so the budgeted resolve in Task 3 pins real behaviour.
    const doc = `# Top\n\n${"filler paragraph text\n\n".repeat(4000)}## Far Heading\n\nend\n`;
    const state = stateOf(doc);
    const partial = ensureSyntaxTree(state, 200, 50) ?? syntaxTree(state);
    expect(partial.length).toBeLessThan(state.doc.length);
    expect(findHeadingBySlug(state, partial, "far-heading")).toBeNull();
    const complete = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(complete).not.toBeNull();
    expect(findHeadingBySlug(state, complete as NonNullable<typeof complete>, "far-heading")).toBe(
      doc.lastIndexOf("## Far Heading")
    );
  });
});
