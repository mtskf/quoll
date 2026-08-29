// Unit test for the fold harnesses' OWN guards. Every production call site of
// settledState() / fullTree() (the fold suites, cm-markdown-language.test.ts,
// reconcile-reseed-folds.test.ts) drives the success path only, so without this
// file a weakening of either throw stays silently green. State-only — no view is
// mounted, so no happy-dom pragma is needed.
import { markdown } from "@codemirror/lang-markdown";
import { defineLanguageFacet, Language, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Input, PartialParse, TreeFragment } from "@lezer/common";
import { NodeType, Parser, Tree } from "@lezer/common";
import { describe, expect, it } from "vitest";
import { fullTree } from "./full-tree.js";
import { settledState } from "./settled-state.js";

describe("a state with no language is reported as such, not as a timeout", () => {
  // `ensureSyntaxTree` returns `null` in 0ms when no Language extension is
  // attached, which is indistinguishable at the call site from an exhausted 5s
  // budget. The precondition check in parse-to-end.ts is what keeps the two
  // apart; these pin that the message names the real cause.
  const languageless = () => EditorState.create({ doc: "# heading\n\nbody\n" });

  it("settledState() names the missing language", () => {
    expect(() => settledState(languageless())).toThrow(/no language configured/);
  });

  it("settledState() does NOT blame the parse budget", () => {
    expect(() => settledState(languageless())).not.toThrow(/within 5s/);
  });

  it("fullTree() reports it the same way (shared throw site)", () => {
    // Both helpers route through parseToEnd, so this is the pin that keeps the
    // sibling from drifting back to the timeout-only story.
    expect(() => fullTree(languageless())).toThrow(/no language configured/);
    expect(() => fullTree(languageless())).not.toThrow(/within 5s/);
  });
});

describe("settledState() republishes the language field's tree snapshot", () => {
  // Longer than CM's 3000-char init viewport, so the snapshot the field is
  // constructed with cannot span the doc.
  const doc = `${"filler paragraph line\n\n".repeat(200)}# tail heading\n`;
  const stateFor = () => EditorState.create({ doc, extensions: [markdown()] });

  it("a freshly-created state's snapshot is truncated (the precondition)", () => {
    // If an upstream change ever made the init snapshot complete, the assertion
    // below would stop proving anything — so it goes red here instead.
    const state = stateFor();
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);
  });

  it("the returned state's snapshot spans the whole doc", () => {
    const settled = settledState(stateFor());
    expect(syntaxTree(settled).length).toBe(settled.doc.length);
  });
});

// A Lezer parser that reports its parse as having reached the end of the input
// while returning a Tree that stops short of it. ParseContext.work() records
// `treeLen` from the parse's stopped position, NOT from the returned tree's
// length, so `ensureSyntaxTree` reports success and LanguageState.apply()
// republishes the short tree — which is exactly the state the truncated-snapshot
// guard exists to reject. A real Lezer parser returns a tree that spans what it
// parsed, so driving that guard needs a parser that splits the two.
const STUB_TREE_LENGTH = 10;
const stubTop = NodeType.define({ id: 0, name: "StubTop", top: true });

class ShortTreeParser extends Parser {
  createParse(
    _input: Input,
    _fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[]
  ): PartialParse {
    return {
      parsedPos: ranges[ranges.length - 1].to,
      stoppedAt: null,
      stopAt() {},
      advance: () => new Tree(stubTop, [], [], STUB_TREE_LENGTH),
    };
  }
}

describe("settledState() throws rather than returning a still-truncated state", () => {
  it("reports how much of the doc the snapshot actually covers", () => {
    const language = new Language(defineLanguageFacet({}), new ShortTreeParser());
    const state = EditorState.create({ doc: "x".repeat(5_000), extensions: [language] });
    expect(() => settledState(state)).toThrow(
      new RegExp(`snapshot still truncated \\(${STUB_TREE_LENGTH} of 5000 code units\\)`)
    );
  });
});
