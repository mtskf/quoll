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
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { settledView } from "./settled-view.js";
import { neverFinishingLanguage, STUB_TREE_LENGTH, shortTreeLanguage } from "./stub-parsers.js";

function mount(doc: string, extensions: Extension[] = [markdown()]): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
}

/**
 * Mount, run `body`, and always destroy — a leaked view keeps a happy-dom document
 * alive. On the throwing arms `settledView` has already destroyed it, so this is a
 * second `destroy()`; that it is harmless is pinned by the last describe, not assumed.
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

describe("a throwing settle destroys the view instead of leaking it", () => {
  // The documented `return settledView(new EditorView({ state, parent }))` shape hands
  // the caller nothing to destroy when the settle throws, and an undisposed view keeps
  // real timers and a happy-dom document alive for the rest of the file (why
  // cm-fold-extension.test.ts destroys in a `finally`). Under load a budget miss is a
  // recorded reality, so one failure would otherwise poison its whole file. Each arm is
  // pinned separately because each throws from a different point in the body.
  //
  // `EditorView.destroy()` calls `this.dom.remove()`, so detachment is the observable
  // proxy: `destroyed` is `private` in the `.d.ts` and unreadable from typed code.
  const detached = (view: EditorView) => !view.dom.isConnected;

  it("after the no-language throw", () => {
    const view = mount("# heading\n\nbody\n", []);
    expect(() => settledView(view)).toThrow(/no language configured/);
    expect(detached(view)).toBe(true);
  });

  it("after the timeout throw", () => {
    const view = mount("x".repeat(5_000), [neverFinishingLanguage()]);
    expect(() => settledView(view, 1)).toThrow(/did not complete within/);
    expect(detached(view)).toBe(true);
  });

  it("after the short-snapshot throw", () => {
    const view = mount("x".repeat(5_000), [shortTreeLanguage()]);
    expect(() => settledView(view)).toThrow(/snapshot still truncated/);
    expect(detached(view)).toBe(true);
  });

  it("and tolerates the caller destroying it a second time", () => {
    // Sites that bind the view themselves already destroy it in their own `finally`, so
    // the helper's destroy is the FIRST of two. `EditorView.destroy()` has no
    // `destroyed` early-return and the flag cannot be read from typed code, so the
    // second call is not guarded — it has to be harmless, and this is what says so.
    const view = mount("x".repeat(5_000), [shortTreeLanguage()]);
    expect(() => settledView(view)).toThrow();
    expect(() => view.destroy()).not.toThrow();
  });

  it("leaves a successful settle attached, so the caller still owns disposal", () => {
    const view = mount(`${"filler paragraph line\n\n".repeat(200)}- a\n  - b\n`, [markdown()]);
    try {
      expect(detached(settledView(view))).toBe(false);
    } finally {
      view.destroy();
    }
  });
});

describe("the failure destroy reaches each widget twice", () => {
  // The one part of CM's teardown that genuinely re-runs on a second destroy:
  // docView.destroy() walks the widgets again. Every widget this repo mounts has an
  // idempotent destroy(), so this is a documented property rather than a live bug — but
  // it is documented in settled-view.ts as a MEASURED number, and a number in prose
  // rots. This pins it, so a future non-idempotent widget destroy is a red test rather
  // than confusing noise inside an already-failing one.
  class CountingWidget extends WidgetType {
    constructor(private readonly onDestroy: () => void) {
      super();
    }
    toDOM(): HTMLElement {
      return document.createElement("span");
    }
    destroy(): void {
      this.onDestroy();
    }
  }

  function widgetPlugin(onDestroy: () => void): Extension {
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor() {
          this.decorations = Decoration.set([
            Decoration.widget({ widget: new CountingWidget(onDestroy), side: 1 }).range(0),
          ]);
        }
      },
      { decorations: (v) => v.decorations }
    );
  }

  it("once from the helper's throw path, once more from the caller's own destroy", () => {
    let destroys = 0;
    const view = mount("x".repeat(5_000), [
      shortTreeLanguage(),
      widgetPlugin(() => {
        destroys += 1;
      }),
    ]);
    expect(() => settledView(view)).toThrow(/snapshot still truncated/);
    expect(destroys).toBe(1); // the helper's cleanup
    view.destroy(); // what a caller that bound the view does in its own finally
    expect(destroys).toBe(2); // ...and the widget sees it again
  });
});
