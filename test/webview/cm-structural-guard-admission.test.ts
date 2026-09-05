// @vitest-environment happy-dom
//
// `requiresFullBoundedRebuild` is the admission test every changed-range-bounded StateField
// applies before it may reuse records. It ORs two terms that answer DIFFERENT questions —
// "could this edit re-shape a block boundary outside the recomputed window?" and "is the
// post-edit parse frontier complete?" — and neither implies the other. Two fields shipped
// with only the second, which is the bug this file's PR fixes; the point of pinning the
// helper directly is that an existing suite can stay green while a term is dropped, because
// no ordinary case discriminates on one term alone.
//
// One case per term, plus the both-false case:
//
//   structural | frontier complete | expected
//   -----------+-------------------+---------
//    true      | true              | true    <- the term the block-widget fields lacked
//    false     | false             | true    <- the term they had (G2)
//    false     | true              | false   <- the bounded hot path
//
// ⚠️ Rows 1 and 3 need a COMPLETE frontier, and they read it AFTER an edit — CodeMirror
// gives that reparse a 20ms wall-clock budget, so under CPU starvation the window can
// elapse while this process is descheduled and the frontier comes back incomplete. A bare
// `expect(syntaxTreeAvailable(...)).toBe(true)` would then red on a fact about the machine,
// which is why `test/build/no-bare-unstarved-gate.test.ts` forbids that shape outright.
// Both rows go through `withUnstarvedFrontierState`, which abandons and retries a starved
// attempt and THROWS if every attempt is starved — so this can neither flake nor pass
// having observed nothing.
//
// Row 2 needs the opposite and is deliberately NOT wrapped: `neverFinishingLanguage()` never
// completes, so its frontier is starved by construction and stays that way under any load.
// Its `.toBe(false)` is the shape the guard explicitly does not flag, for the same reason —
// starvation can only make a frontier less complete.
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
import { withUnstarvedFrontierState } from "./helpers/unstarved-frontier.js";

const DOC = "prose paragraph here\n\nmore text\n";
const exts = (): Extension[] => [markdown({ base: markdownLanguage })];

/** Build the post-edit state fresh inside the callback: `withUnstarvedFrontierState` re-runs
 *  its observation from the top on every retry, so anything built outside would be shared
 *  across attempts. */
function edited(change: { from: number; to?: number; insert?: string }): EditorState {
  return settledState(EditorState.create({ doc: DOC, extensions: exts() })).update({
    changes: change,
  }).state;
}

describe("requiresFullBoundedRebuild", () => {
  it("row 1 — structural edit, complete frontier => true (the term block-widget fields lacked)", () => {
    withUnstarvedFrontierState({
      what: "the admission verdict on a structural edit",
      observe: (requireUnstarvedFrontier) => {
        const state = edited({ from: 0, insert: "```" });
        requireUnstarvedFrontier(state);
        // Re-derive the transaction the helper is asked about from the same base, so the
        // verdict below is read off the state the gate just spoke for.
        const tr = settledState(EditorState.create({ doc: DOC, extensions: exts() })).update({
          changes: { from: 0, insert: "```" },
        });
        expect(touchesStructuralReparse(tr)).toBe(true);
        expect(requiresFullBoundedRebuild(tr)).toBe(true);
        return state;
      },
    });
  });

  it("row 2 — inert edit, starved frontier => true (G2, the term the fields already had)", () => {
    const state = EditorState.create({ doc: DOC, extensions: [neverFinishingLanguage()] });
    const tr = state.update({ changes: { from: 10, insert: "x" } });
    expect(touchesStructuralReparse(tr)).toBe(false);
    expect(syntaxTreeAvailable(tr.state, tr.state.doc.length)).toBe(false);
    expect(requiresFullBoundedRebuild(tr)).toBe(true);
  });

  it("row 3 — inert edit, complete frontier => false (the bounded hot path)", () => {
    withUnstarvedFrontierState({
      what: "the admission verdict on a structurally inert edit",
      observe: (requireUnstarvedFrontier) => {
        const state = edited({ from: 10, insert: "x" });
        requireUnstarvedFrontier(state);
        const tr = settledState(EditorState.create({ doc: DOC, extensions: exts() })).update({
          changes: { from: 10, insert: "x" },
        });
        expect(touchesStructuralReparse(tr)).toBe(false);
        expect(requiresFullBoundedRebuild(tr)).toBe(false);
        return state;
      },
    });
  });
});
