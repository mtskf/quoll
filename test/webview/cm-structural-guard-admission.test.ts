// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTreeAvailable } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  requiresFullBoundedRebuild,
  touchesStructuralReparse,
} from "../../src/webview/cm/structural-guard.js";
import { settledState } from "./helpers/settled-state.js";
import { neverFinishingLanguage } from "./helpers/stub-parsers.js";

const DOC = "prose paragraph here\n\nmore text\n";
const exts = (): Extension[] => [markdown({ base: markdownLanguage })];

// requiresFullBoundedRebuild must answer TRUE when EITHER term does. One case per term
// plus the both-false case is what makes dropping a term red; a suite that only ever sees
// them agree cannot tell a two-term test from a one-term one.
//
//  structural | frontier complete | expected
//  -----------+-------------------+---------
//   true      | true              | true    <- the term the block-widget fields lacked
//   false     | false             | true    <- the term they had (G2)
//   false     | true              | false   <- the bounded hot path
describe("requiresFullBoundedRebuild", () => {
  it("row 1 — structural edit, complete frontier => true (the term block-widget fields lacked)", () => {
    const state = settledState(EditorState.create({ doc: DOC, extensions: exts() }));
    const tr = state.update({ changes: { from: 0, insert: "```" } });
    expect(touchesStructuralReparse(tr)).toBe(true);
    expect(syntaxTreeAvailable(tr.state, tr.state.doc.length)).toBe(true);
    expect(requiresFullBoundedRebuild(tr)).toBe(true);
  });

  it("row 2 — inert edit, starved frontier => true (G2, the term the fields already had)", () => {
    const state = EditorState.create({ doc: DOC, extensions: [neverFinishingLanguage()] });
    const tr = state.update({ changes: { from: 10, insert: "x" } });
    expect(touchesStructuralReparse(tr)).toBe(false);
    expect(syntaxTreeAvailable(tr.state, tr.state.doc.length)).toBe(false);
    expect(requiresFullBoundedRebuild(tr)).toBe(true);
  });

  it("row 3 — inert edit, complete frontier => false (the bounded hot path)", () => {
    const state = settledState(EditorState.create({ doc: DOC, extensions: exts() }));
    const tr = state.update({ changes: { from: 10, insert: "x" } });
    expect(touchesStructuralReparse(tr)).toBe(false);
    expect(syntaxTreeAvailable(tr.state, tr.state.doc.length)).toBe(true);
    expect(requiresFullBoundedRebuild(tr)).toBe(false);
  });
});
