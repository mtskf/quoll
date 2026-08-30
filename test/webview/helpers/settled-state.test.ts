// Unit test for the fold harnesses' OWN guards. The suites that use
// settledState() / fullTree() drive the success path only, so without this file
// a weakening of either throw stays silently green. State-only — no view is
// mounted, so no happy-dom pragma is needed.
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fullTree } from "./full-tree.js";
import { parseToEnd } from "./parse-to-end.js";
import { settledState } from "./settled-state.js";
import { neverFinishingLanguage, STUB_TREE_LENGTH, shortTreeLanguage } from "./stub-parsers.js";

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

describe("an exhausted parse budget is reported as a timeout", () => {
  it("names the budget it was given and the doc size", () => {
    const state = EditorState.create({
      doc: "x".repeat(5_000),
      extensions: [neverFinishingLanguage()],
    });
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

describe("both helpers throw rather than handing back a tree that stops short", () => {
  const shortTreeState = () => {
    return EditorState.create({ doc: "x".repeat(5_000), extensions: [shortTreeLanguage()] });
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
