// @vitest-environment happy-dom
// Unit test for settledView()'s OWN guards — the mounted-view twin of
// ./settled-state.test.ts. The suites that call settledView() drive the success path
// only, so without this file a weakening of any of its three throws stays silently
// green. It is a separate file because mounting a view needs happy-dom, and
// settled-state.test.ts is deliberately state-only ("no view is mounted, so no
// happy-dom pragma is needed") — adding a pragma there would falsify its own header
// and change the environment of its existing describes.
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { settledView } from "./settled-view.js";
import { neverFinishingLanguage, STUB_TREE_LENGTH, shortTreeLanguage } from "./stub-parsers.js";

function mount(doc: string, extensions: Extension[] = [markdown()]): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/** Mount, run `body`, and always destroy — a leaked view keeps a happy-dom document alive. */
function withView(doc: string, extensions: Extension[], body: (view: EditorView) => void): void {
  const view = mount(doc, extensions);
  try {
    body(view);
  } finally {
    view.destroy();
  }
}

describe("a view with no language is reported as such, not as a timeout", () => {
  // `forceParsing` is `ensureSyntaxTree` plus a conditional dispatch, so with no
  // Language extension attached it returns `false` in 0ms — indistinguishable at the
  // call site from an exhausted budget. The precondition borrowed from parse-to-end.ts
  // is what keeps the two apart; these pin that the message names the real cause.
  it("settledView() names the missing language", () => {
    withView("# heading\n\nbody\n", [], (view) => {
      expect(() => settledView(view)).toThrow(/no language configured/);
    });
  });

  it("settledView() does NOT blame the parse budget", () => {
    withView("# heading\n\nbody\n", [], (view) => {
      expect(() => settledView(view)).not.toThrow(/did not complete within/);
    });
  });
});

describe("an exhausted parse budget is reported as a timeout", () => {
  it("names the budget it was given and the doc size", () => {
    // A 1ms budget against a parser that never finishes reaches the timeout arm without
    // a five-second hang. Deterministic, unlike a 0ms budget on a real parser — that
    // may converge anyway and leave the arm untested.
    withView("x".repeat(5_000), [neverFinishingLanguage()], (view) => {
      expect(() => settledView(view, 1)).toThrow(
        /settledView: parse did not complete within 1ms for a 5000-code-unit document/
      );
    });
  });
});

describe("settledView() republishes the mounted view's tree snapshot", () => {
  // >3000 chars: LanguageState.init caps its init viewport at 3000 chars, so a longer
  // doc deterministically starts truncated — no CPU-load dependence. Same construction
  // as cm-fold-blockquote.test.ts's settled-parse describe.
  const doc = `${"filler paragraph line\n\n".repeat(200)}- a\n  - b\n`;

  it("a freshly-mounted view's snapshot is truncated (the precondition)", () => {
    // Pins the CM behaviour the guard below rests on: if an upstream change ever made
    // the init snapshot complete, that guard would be vacuous — so it reds here instead
    // of silently passing.
    withView(doc, [markdown()], (view) => {
      expect(syntaxTree(view.state).length).toBeLessThan(view.state.doc.length);
    });
  });

  it("the settled view's snapshot spans the whole doc", () => {
    withView(doc, [markdown()], (view) => {
      expect(syntaxTree(settledView(view).state).length).toBe(view.state.doc.length);
    });
  });
});

describe("settledView() throws rather than handing back a view whose tree stops short", () => {
  it("reports how much of the doc the snapshot actually covers", () => {
    // DEFENSIVE arm, driven by the inconsistency injector in ./stub-parsers.ts — see
    // that module for why no conformant parser reaches it, and for the upstream change
    // that would mean deleting this rather than chasing it.
    withView("x".repeat(5_000), [shortTreeLanguage()], (view) => {
      expect(() => settledView(view)).toThrow(
        new RegExp(`snapshot still truncated \\(${STUB_TREE_LENGTH} of 5000 code units\\)`)
      );
    });
  });
});
