// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  findHeadingBySlug,
  isActionableLinkTarget,
  type ParseReach,
  resolveLinkTarget,
} from "../../src/webview/cm/link-resolve.js";
import { classifyLinkTarget } from "../../src/webview/cm/link-target.js";
import { fullTree } from "./helpers/full-tree.js";

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

function lookup(doc: string, slug: string): number | null {
  const state = stateOf(doc);
  return findHeadingBySlug(state, fullTree(state), slug);
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
    expect(findHeadingBySlug(before, fullTree(before), "alpha")).toBe(0);
    const after = before.update({ changes: { from: 0, insert: "lead-in\n\n" } }).state;
    expect(findHeadingBySlug(after, fullTree(after), "alpha")).toBe("lead-in\n\n".length);
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
    const tree = fullTree(before);
    expect(findHeadingBySlug(before, tree, "alpha")).toBe(0);
    const after = before.update({ changes: { from: 2, to: 7, insert: "Gamma" } }).state;
    expect(after.doc.length).toBe(before.doc.length);
    expect(findHeadingBySlug(after, tree, "alpha")).toBeNull();
    expect(findHeadingBySlug(after, tree, "gamma")).toBe(0);
  });

  it("skips a heading the STALE tree places past the end of a shortened document", () => {
    // TOTALITY PIN. `state` and `tree` are independent arguments, so a tree can
    // describe a document longer than the one it is handed, and this function
    // runs inside a DecorationProvider.build() where the orchestrator's guard
    // would turn a throw into a silently missing link decoration — which is
    // exactly why the contract needs pinning here rather than in the editor.
    const doc = "intro\n\n## Second Heading\n\nbody\n";
    const before = stateOf(doc);
    const staleTree = fullTree(before);
    const headingStart = lineStartOf(doc, "## Second");
    expect(findHeadingBySlug(before, staleTree, "second-heading")).toBe(headingStart);
    // Truncate to "in". Assert the HAZARD, not just the outcome: this is the
    // scenario in which the index's own `doc.lineAt(from)` would throw, so if a
    // later edit softens the fixture into a harmless one this line goes red
    // before the not-toThrow below silently stops proving anything.
    const after = before.update({ changes: { from: 2, to: doc.length } }).state;
    expect(after.doc.length).toBe(2);
    expect(() => after.doc.lineAt(headingStart)).toThrow(RangeError);
    expect(() => findHeadingBySlug(after, staleTree, "second-heading")).not.toThrow();
    expect(findHeadingBySlug(after, staleTree, "second-heading")).toBeNull();
  });

  it("indexes the RENDERED heading content, so a link's destination is not in the slug", () => {
    const doc = "# A [link](b)\n\nbody\n";
    expect(lookup(doc, "a-link")).toBe(0);
    expect(lookup(doc, "a-linkb")).toBeNull();
  });

  it("cannot see a heading beyond a PARTIAL tree (the premise the click budget answers)", () => {
    // Non-vacuity guard: prove a bounded tree really can miss a far heading, so
    // resolveLinkTarget's `{ completeWithinMs }` reach pins real behaviour
    // rather than a tautology.
    const doc = `# Top\n\n${"filler paragraph text\n\n".repeat(4000)}## Far Heading\n\nend\n`;
    const state = stateOf(doc);
    // This fixture is DELIBERATELY partial — do not run it through `fullTree` /
    // `settledState`, which would settle the parse and make this assertion vacuous.
    const partial = ensureSyntaxTree(state, 200, 50) ?? syntaxTree(state);
    expect(partial.length).toBeLessThan(state.doc.length);
    expect(findHeadingBySlug(state, partial, "far-heading")).toBeNull();
    const complete = fullTree(state);
    expect(findHeadingBySlug(state, complete, "far-heading")).toBe(
      doc.lastIndexOf("## Far Heading")
    );
  });
});

describe("resolveLinkTarget", () => {
  // `fullTree`, not `syntaxTree`: resolveLinkTarget is HANDED the tree and only
  // re-ensures when `reach !== "viewport-only"` (link-resolve.ts), so on the default
  // reach it walks this snapshot verbatim. A truncated one loses the heading and the
  // `no-action` rows below would be green for the wrong reason. The three fixtures
  // further down that DELIBERATELY stay partial are marked as such; this is not one.
  function resolve(doc: string, destination: string, reach: ParseReach = "viewport-only") {
    const state = stateOf(doc);
    return resolveLinkTarget(state, fullTree(state), classifyLinkTarget(destination), reach);
  }

  it("passes every non-fragment arm through untouched", () => {
    const doc = "# H\n\ntext\n";
    expect(resolve(doc, "https://example.com")).toEqual({
      kind: "external",
      href: "https://example.com",
    });
    expect(resolve(doc, "notes.md")).toEqual({ kind: "workspace", href: "notes.md" });
    expect(resolve(doc, "./photo.png")).toEqual({ kind: "no-action" });
  });

  it("resolves a matching fragment to a scroll target", () => {
    const doc = "intro\n\n## Getting Started\n\nbody\n";
    expect(resolve(doc, "#getting-started")).toEqual({
      kind: "scroll",
      pos: doc.indexOf("## Getting"),
    });
  });

  it("collapses an unmatched fragment to no-action", () => {
    expect(resolve("# One\n\ntext\n", "#missing")).toEqual({ kind: "no-action" });
  });

  it("resolves a fragment against the RENDERED heading content", () => {
    const doc = "# A [link](b)\n\nbody\n";
    expect(resolve(doc, "#a-link")).toEqual({ kind: "scroll", pos: 0 });
    expect(resolve(doc, "#a-linkb")).toEqual({ kind: "no-action" });
  });

  it("finds a far heading when given a parse budget, and misses it without one", () => {
    // The reach asymmetry, in one test: the CLICK path forces a complete parse
    // because syntaxTree only guarantees the viewport (+~100 KB); the decoration
    // path stays "viewport-only" and accepts the miss (a missing pointer, never
    // a dead click).
    const doc = `# Top\n\n${"filler paragraph text\n\n".repeat(4000)}## Far Heading\n\nend\n`;
    const state = stateOf(doc);
    // This fixture is DELIBERATELY partial — do not run it through `fullTree` /
    // `settledState`, which would settle the parse and make this assertion vacuous.
    const partial = ensureSyntaxTree(state, 200, 50) ?? syntaxTree(state);
    expect(partial.length).toBeLessThan(state.doc.length);
    const target = classifyLinkTarget("#far-heading");
    expect(resolveLinkTarget(state, partial, target, "viewport-only")).toEqual({
      kind: "no-action",
    });
    expect(resolveLinkTarget(state, partial, target, { completeWithinMs: 5000 })).toEqual({
      kind: "scroll",
      pos: doc.lastIndexOf("## Far Heading"),
    });
  });

  it("reports an exhausted budget as unresolved-fragment, not no-action", () => {
    // The distinction the arm exists for: in a large document a REAL heading
    // that the parse never reached must not read as "no such heading". Both
    // halves use a fresh state so neither inherits the other's parse progress.
    const doc = `# Top\n\n${"filler paragraph text\n\n".repeat(8000)}## Far Heading\n\nend\n`;
    const target = classifyLinkTarget("#far-heading");

    // `starved` and `fed` both need the TRUNCATED init snapshot — `starved` to
    // reproduce a starved budget, `fed` as its non-vacuity twin — so neither may
    // go through `fullTree` / `settledState`, which would settle the parse first.
    const starved = stateOf(doc);
    expect(
      resolveLinkTarget(starved, syntaxTree(starved), target, { completeWithinMs: 1 })
    ).toEqual({ kind: "unresolved-fragment" });

    // Non-vacuity: the SAME slug in the SAME document resolves once the budget
    // is real, so the arm above is about the budget and not a missing heading.
    const fed = stateOf(doc);
    expect(resolveLinkTarget(fed, syntaxTree(fed), target, { completeWithinMs: 10_000 })).toEqual({
      kind: "scroll",
      pos: doc.lastIndexOf("## Far Heading"),
    });
  });

  it("keeps no-action for a genuinely absent heading even when a budget was given", () => {
    // The budget arm must not swallow the honest negative: a completed parse
    // that finds nothing is `no-action`, which stays silent at the click site.
    expect(resolve("# One\n\ntext\n", "#missing", { completeWithinMs: 5000 })).toEqual({
      kind: "no-action",
    });
  });
});

describe("isActionableLinkTarget", () => {
  it("is true for exactly the arms a click acts on", () => {
    expect(isActionableLinkTarget({ kind: "external", href: "https://x" })).toBe(true);
    expect(isActionableLinkTarget({ kind: "workspace", href: "a.md" })).toBe(true);
    expect(isActionableLinkTarget({ kind: "scroll", pos: 0 })).toBe(true);
    expect(isActionableLinkTarget({ kind: "no-action" })).toBe(false);
    expect(isActionableLinkTarget({ kind: "oversize", length: 1 })).toBe(false);
    expect(isActionableLinkTarget({ kind: "blocked", schemeToken: "(none)" })).toBe(false);
    expect(isActionableLinkTarget({ kind: "unopenable-scheme", scheme: "ftp" })).toBe(false);
    // "could not determine" is not "act": the pointer must not promise a scroll
    // the click cannot deliver.
    expect(isActionableLinkTarget({ kind: "unresolved-fragment" })).toBe(false);
  });
});
