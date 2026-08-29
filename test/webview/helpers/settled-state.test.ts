// Unit test for the fold harnesses' OWN guards. The suites that use
// settledState() / fullTree() drive the success path only, so without this file
// a weakening of either throw stays silently green. State-only — no view is
// mounted, so no happy-dom pragma is needed.
import { markdown } from "@codemirror/lang-markdown";
import { defineLanguageFacet, Language, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { Input, PartialParse, TreeFragment } from "@lezer/common";
import { NodeType, Parser, Tree } from "@lezer/common";
import { describe, expect, it } from "vitest";
import { fullTree } from "./full-tree.js";
import { parseToEnd } from "./parse-to-end.js";
import { settledState } from "./settled-state.js";

// Top node for the trees the stub parsers below return; its shape is irrelevant,
// only the tree's length is.
const stubTop = NodeType.define({ id: 0, name: "StubTop", top: true });

describe("a state with no language is reported as such, not as a timeout", () => {
  // `ensureSyntaxTree` returns `null` in 0ms when no Language extension is
  // attached, which is indistinguishable at the call site from an exhausted
  // parse budget. The precondition check in parse-to-end.ts is what keeps the
  // two apart; these pin that the message names the real cause.
  const languageless = () => EditorState.create({ doc: "# heading\n\nbody\n" });

  it("settledState() names the missing language", () => {
    expect(() => settledState(languageless())).toThrow(/no language configured/);
  });

  it("settledState() does NOT blame the parse budget", () => {
    expect(() => settledState(languageless())).not.toThrow(/did not complete within/);
  });

  it("fullTree() reports it the same way (shared throw site)", () => {
    // Both helpers route through parseToEnd, so this is the pin that keeps the
    // sibling from drifting back to the timeout-only story.
    expect(() => fullTree(languageless())).toThrow(/no language configured/);
    expect(() => fullTree(languageless())).not.toThrow(/did not complete within/);
  });
});

// A parser that never finishes on its own: `advance()` yields nothing until the
// caller stops it, so the only way out of ParseContext.work() is the
// elapsed-time check. Driving parseToEnd with a 1ms budget reaches its timeout
// arm without a five-second hang. Honouring `stopAt` is load-bearing rather than
// decoration: CM's takeTree() calls it and then spins in `while (!advance()) {}`,
// which a stub that ignored it would never leave.
class NeverFinishingParser extends Parser {
  createParse(): PartialParse {
    let stopped: number | null = null;
    return {
      parsedPos: 0,
      get stoppedAt() {
        return stopped;
      },
      stopAt(pos: number) {
        stopped = pos;
      },
      advance: () => (stopped === null ? null : new Tree(stubTop, [], [], stopped)),
    };
  }
}

describe("an exhausted parse budget is reported as a timeout", () => {
  it("names the budget it was given and the doc size", () => {
    const language = new Language(defineLanguageFacet({}), new NeverFinishingParser());
    const state = EditorState.create({ doc: "x".repeat(5_000), extensions: [language] });
    expect(() => parseToEnd(state, "settledState", 1)).toThrow(
      /settledState: parse did not complete within 1ms for a 5000-code-unit document/
    );
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

// A parser that deliberately VIOLATES the Lezer contract: it claims a parsedPos
// at the end of the input while returning a Tree that stops short of it, and its
// stopAt() is a no-op. ParseContext.work() sets `treeLen` to
// `parse.stoppedAt ?? state.doc.length` — never to the returned tree's length —
// and the no-op stopAt() leaves `stoppedAt` null, so `treeLen` lands on the full
// doc length while the tree is 10 units long.
// `ensureSyntaxTree` then reports success, fullTree() receives the short tree,
// and LanguageState.apply() republishes it as the state's snapshot.
//
// ⚠️ This is an INCONSISTENCY INJECTOR, not a model of CodeMirror behaviour. No
// conformant parser reaches either helper's span guard: after a successful
// parseToEnd the context is `isDone`, so apply()'s 20ms budget is never spent
// re-parsing. Both guards are DEFENSIVE, and the tests below pin only that they
// still fire and still report the coverage numbers — not that anything in the
// tree today produces a short tree. The stub is also coupled to CM-private
// work() bookkeeping: if upstream ever derives treeLen from the returned tree,
// delete this describe rather than chase it.
const STUB_TREE_LENGTH = 10;

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

describe("both helpers throw rather than handing back a tree that stops short", () => {
  const shortTreeState = () => {
    const language = new Language(defineLanguageFacet({}), new ShortTreeParser());
    return EditorState.create({ doc: "x".repeat(5_000), extensions: [language] });
  };

  it("settledState() reports how much of the doc the snapshot actually covers", () => {
    expect(() => settledState(shortTreeState())).toThrow(
      new RegExp(`snapshot still truncated \\(${STUB_TREE_LENGTH} of 5000 code units\\)`)
    );
  });

  it("fullTree() reports how much of the doc the returned tree actually covers", () => {
    expect(() => fullTree(shortTreeState())).toThrow(
      new RegExp(`tree spans ${STUB_TREE_LENGTH} of 5000 code units`)
    );
  });
});
