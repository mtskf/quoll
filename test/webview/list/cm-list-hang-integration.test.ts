// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  buildListHangIndent,
  listHangIndent,
} from "../../../src/webview/cm/list/list-hang-indent.js";
import {
  CM_LINE_START_PADDING,
  cmLinePaddingThemeSpec,
  quollCmLinePaddingTheme,
} from "../../../src/webview/cm/theme.js";
import { fullTree } from "../helpers/full-tree.js";

// Integration: mount a REAL EditorView with the listHangIndent ViewPlugin over
// the live `@codemirror/lang-markdown` parser, and check that the plugin is
// installed and the resolver's geometry flows from the live view state.
//
// Why not assert the style attribute on the rendered `.cm-line` directly?
// happy-dom has no layout engine (getBoundingClientRect → 0, coordsAtPos →
// null), so CM's viewport measurement is non-deterministic: under the full
// parallel suite a list line occasionally renders BEFORE the ViewPlugin has
// rebuilt its line decoration for that line (view.visibleRanges briefly
// excludes it), leaving a `.cm-line` with no `style` — a flaky failure that
// does not reproduce in isolation. The decoration BUILD is a pure function of
// (state, tree, range), so we exercise it directly over the LIVE view.state —
// but BOTH non-deterministic inputs must be pinned, not just one:
//   - range: pass an explicit full-document range, never view.visibleRanges.
//   - tree:  syntaxTree(view.state) returns only what CM's bounded initial
//            parse (~20ms Work.Apply budget) produced. Under full-suite CPU
//            contention that budget expires after the first list item, so the
//            lazy tree carries one Task node instead of three and the build
//            yields ONE hang decoration ("expected length 3, got 1") — green in
//            isolation, flaky under load. We read through fullTree()
//            (ensureSyntaxTree → complete parse) so the tree is always whole.
//            Pinning the range alone — the original fix — left this second race
//            live; the parse-readiness test below deterministically reproduces
//            and guards it.
// The result is deterministic and still end-to-end (real EditorView lifecycle +
// plugin install + live parser tree + rendered lines). happy-dom's CSSOM also
// drops `text-indent: calc(-1 * (...))`; real-pixel / rendered-attribute /
// text-indent fidelity needs a real browser (tracked follow-up TODO).

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      // quollCmLinePaddingTheme wires the real editor's `.cm-line` padding — the
      // finding this closes: mount() previously omitted it, so the test never
      // reproduced the actual editor wiring the hang decoration relies on.
      extensions: [markdown({ base: markdownLanguage }), listHangIndent, quollCmLinePaddingTheme],
    }),
    parent,
  });
}

/** Inline styles of the hang line-decorations the live view's state produces,
 *  built over a deterministic full-document range (not view.visibleRanges) and
 *  the SUPPLIED syntax tree. Callers choose which tree to pass — the geometry
 *  assertions use fullTree (complete parse); the parse-readiness regression
 *  passes the raw lazy tree to prove its truncation. */
function hangStylesOverTree(view: EditorView, tree: ReturnType<typeof fullTree>): string[] {
  const set: DecorationSet = buildListHangIndent({
    state: view.state,
    selection: view.state.selection,
    visibleRanges: [{ from: 0, to: view.state.doc.length }],
    tree,
  });
  const out: string[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { attributes?: { style?: string } };
    out.push(spec.attributes?.style ?? "");
    iter.next();
  }
  return out;
}

/** Styles over a COMPLETE parse — the deterministic read the geometry
 *  assertions use. fullTree forces ensureSyntaxTree so a budget-truncated
 *  initial parse can never yield a short result (see the file header). */
function liveLineStyles(view: EditorView): string[] {
  return hangStylesOverTree(view, fullTree(view.state));
}

describe("list hang-indent — ViewPlugin wired into a real editor (F3/F5 integration)", () => {
  it("task → task → plain: the live plugin yields each line's resolver pad", () => {
    const view = mount("- [ ] a\n  - [ ] b\n    - c");
    try {
      // The ViewPlugin is installed in a real EditorView (module-const identity
      // — view.plugin() resolves it) and the list lines render.
      expect(view.plugin(listHangIndent)).not.toBeNull();
      expect(view.contentDOM.querySelectorAll(".cm-line")).toHaveLength(3);

      const styles = liveLineStyles(view);
      expect(styles).toHaveLength(3);
      // line 0 — top task (no parent, no step)
      expect(styles[0]).toContain(
        "calc(var(--quoll-column-inset-left, 6px) + (0 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)))"
      );
      // line 1 — task under task (one checkbox shift + one NEST_STEP), caret off
      // this line → the marker-to-text gap term is appended (list-marker-restyle).
      expect(styles[1]).toContain(
        "calc(var(--quoll-column-inset-left, 6px) + (2 * var(--quoll-prose-space, 1ch) + 2 * var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
      );
      // line 2 — plain leaf two task levels deep (two shifts + two steps), and
      // its OWN plain `-` marker splits into 1 glyph col + 1 space col (the glyph
      // blend), so the 6 whitespace cols become 5 * space + 1 * glyph. Caret off
      // this line too → the gap term is appended.
      expect(styles[2]).toContain(
        "calc(var(--quoll-column-inset-left, 6px) + (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + 2 * var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
      );
    } finally {
      view.destroy();
    }
  });

  it("yields every line's pad even when the initial parse was budget-truncated (parse-readiness)", () => {
    // Regression for the C9b-surfaced flake (CM integration tests flake under
    // the parallel full-suite run). Deterministically reproduce the truncated
    // initial parse by starving Date.now() during create so CM's parse-work
    // loop bails right after the first advance() — exactly what full-suite CPU
    // contention does intermittently. With the raw lazy tree the build yields
    // ONE pad ("expected length 3, got 1"); fullTree() must recover all three.
    let clock = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000_000));
    let view: EditorView | undefined;
    try {
      view = mount("- [ ] a\n  - [ ] b\n    - c");
      // NON-VACUITY GUARD (runs while the clock is still starved): the lazy
      // tree is genuinely truncated, so building over it yields fewer than the
      // three pads the complete tree carries. If this ever stops truncating the
      // assertion below would pass for the wrong reason — this guard reds CI.
      expect(hangStylesOverTree(view, syntaxTree(view.state)).length).toBeLessThan(3);
      // Restore the real clock BEFORE fullTree: ensureSyntaxTree measures its
      // 5s budget via Date.now, so the starved clock would make it return null.
      spy.mockRestore();
      // THE FIX: liveLineStyles reads through fullTree (ensureSyntaxTree), so a
      // complete parse is forced and all three lines' pads are present.
      expect(liveLineStyles(view)).toHaveLength(3);
    } finally {
      spy.mockRestore();
      view?.destroy();
    }
  });

  it("a non-list paragraph yields no hang decoration", () => {
    const view = mount("just a paragraph");
    try {
      expect(view.contentDOM.querySelector(".cm-line")?.classList.contains("quoll-list-hang")).toBe(
        false
      );
      expect(liveLineStyles(view)).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("the `.cm-line` padding theme and the hang decoration base share one token", () => {
    // Pins that cmLinePaddingThemeSpec's `.cm-line` left padding and the
    // list-hang decoration's base (list-hang-indent.ts) both resolve to the
    // SAME CM_LINE_START_PADDING constant — pointing at the canonical
    // --quoll-column-inset-left token — so the two can never silently drift
    // apart, and neither side can regress to a hardcoded literal or a
    // different token name.
    expect(cmLinePaddingThemeSpec[".cm-line"].paddingLeft).toBe(CM_LINE_START_PADDING);
    expect(CM_LINE_START_PADDING).toContain("--quoll-column-inset-left");
  });
});
