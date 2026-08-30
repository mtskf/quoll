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
import { settledMount, settledView } from "./settled-view.js";
import { neverFinishingLanguage, STUB_TREE_LENGTH, shortTreeLanguage } from "./stub-parsers.js";

function mount(doc: string, extensions: Extension[] = [markdown()]): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/**
 * Mount, run `body`, and always destroy — a leaked view keeps a happy-dom document
 * alive. For a view mounted here this `destroy()` is the only one it ever gets:
 * `settledView` disposes of nothing it was handed, so the caller's `finally` is the whole
 * teardown. The throwing half of that rule is pinned by the last describe; the success
 * half shows up as the settled-snapshot tests below still reading the view afterwards.
 */
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
      expect(() => settledView(view)).toThrow(/^settledView: state has no language configured/);
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
        /^settledView: parse did not complete within 1ms for a 5000-code-unit document/
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
        new RegExp(
          `^settledView: snapshot still truncated \\(${STUB_TREE_LENGTH} of 5000 code units\\)`
        )
      );
    });
  });
});

describe("settledMount destroys what it built when the settle throws", () => {
  // `settledMount` exists to close the leak a factory hits when it settles a view before
  // handing the reference back: the caller never receives it, so a throw would otherwise
  // strand a mounted view with its timers and its happy-dom document alive for the rest
  // of the file. Each arm is pinned separately because each throws from a different point
  // in the body.
  //
  // `EditorView.destroy()` calls `this.dom.remove()`, so detachment is the observable
  // proxy: `destroyed` is `private` in the `.d.ts` and unreadable from typed code. The
  // view is reached through the thrown-away construction, so the assertions capture the
  // parent and look for an emptied DOM rather than holding the view itself.
  function mountThrowing(
    doc: string,
    extensions: Extension[],
    expectedMessage: RegExp,
    budgetMs?: number
  ): HTMLElement {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const config = { parent, state: EditorState.create({ doc, extensions }) };
    // Pinned on the message, not just "something threw": a bare .toThrow() would also
    // accept a failure inside `new EditorView(config)`, and then `parent` is empty for
    // the wrong reason and all three arms below pass vacuously.
    expect(() =>
      budgetMs === undefined ? settledMount(config) : settledMount(config, budgetMs)
    ).toThrow(expectedMessage);
    return parent;
  }

  it("after the no-language throw", () => {
    expect(
      mountThrowing("# heading\n\nbody\n", [], /^settledMount: state has no language configured/)
        .children
    ).toHaveLength(0);
  });

  it("after the timeout throw", () => {
    expect(
      mountThrowing(
        "x".repeat(5_000),
        [neverFinishingLanguage()],
        /^settledMount: parse did not complete within 1ms/,
        1
      ).children
    ).toHaveLength(0);
  });

  it("after the short-snapshot throw", () => {
    expect(
      mountThrowing(
        "x".repeat(5_000),
        [shortTreeLanguage()],
        /^settledMount: snapshot still truncated/
      ).children
    ).toHaveLength(0);
  });

  it("leaves a successful mount attached, so the caller owns disposal", () => {
    // The other half of the contract: settledMount only disposes of what it failed to
    // hand back. A caller receiving a view is in exactly the position it would be in
    // after `new EditorView(...)`.
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = settledMount({
      parent,
      state: EditorState.create({
        doc: `${"filler paragraph line\n\n".repeat(200)}- a\n  - b\n`,
        extensions: [markdown()],
      }),
    });
    try {
      expect(view.dom.isConnected).toBe(true);
    } finally {
      view.destroy();
    }
  });
});

describe("settledView does NOT dispose of a view it was handed", () => {
  // The ownership rule that keeps the sites that mount and dispose for themselves
  // from destroying twice — and, through that, keeps CM's `docView.destroy()` from
  // re-running every widget's `destroy()` while a test is already failing.
  it("leaves the caller's view attached after a throw", () => {
    const view = mount("x".repeat(5_000), [shortTreeLanguage()]);
    try {
      expect(() => settledView(view)).toThrow(/snapshot still truncated/);
      expect(view.dom.isConnected).toBe(true);
    } finally {
      view.destroy();
    }
  });
});
