import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import "../../src/webview/styles.css";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { ThematicBreakWidget } from "../../src/webview/cm/decorations/thematic-break-widget.js";
import { settled } from "./helpers/frames.js";

// The SECOND door. `EditorView.measure` calls the same `docView.update`
// (@codemirror/view/dist:8150) from the rAF loop, so a widget entering the
// viewport builds its DOM with no host message and no applyDocument call on the
// stack. A containment placed in applyDocument would not be on this path at all
// — which is why this test lives in the browser suite: happy-dom has no layout,
// so nothing is ever "below the fold" there.
//
// ⚠️ ThematicBreakWidget is emitted by the `thematicBreakReveal` PROVIDER
// through the `quollSyntaxReveal()` ViewPlugin (decorations/thematic-break-
// reveal.ts:41,107), not by a StateField. Deliberate, and it does not weaken the
// test: the tile builder does not care where a decoration came from, and the
// reveal plugin is viewport-driven, which is precisely the door under test. The
// StateField block-widget path is covered by the table case in Task 5 Step 1.
// Extension set mirrors test/webview/decorations/cm-decoration-thematic-break.test.ts.

it("real browser: a widget that throws as it scrolls into view does not wedge the editor", async () => {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const doc = `${"filler\n\n".repeat(400)}---\n\ntail\n`;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        // Constrain the SCROLLER, not the parent: CodeMirror scrolls
        // `.cm-scroller`, and styles.css's height chain only applies under
        // `.quoll-editor`, which this bare mount does not have.
        EditorView.theme({ "&": { height: "200px" }, ".cm-scroller": { overflow: "auto" } }),
      ],
    }),
    parent,
  });
  try {
    // Pin the parse to the whole document BEFORE scrolling, or this test proves
    // nothing. CodeMirror's initial parse stops at Work.InitViewport = 3000
    // chars (`@codemirror/language/dist:542`) and this document is ~3210, so the
    // trailing `---` is outside it. ⚠️ `ensureSyntaxTree` is NOT enough: it
    // advances `field.context.tree` but leaves `syntaxTree(view.state)` — what
    // the reveal provider actually reads — stale (measured: 3210 vs 3007 chars,
    // no HorizontalRule). `forceParsing` dispatches an empty transaction so the
    // state's tree catches up; editor.ts:1090 relies on the same distinction.
    // With the tree complete the parse worker has nothing left to dispatch, so
    // no stray update can race the spy.
    expect(forceParsing(view, doc.length, 5000)).toBe(true);
    await settled();
    // The reveal's real premise: the node it decorates is in the PUBLISHED tree.
    let sawRule = false;
    syntaxTree(view.state).iterate({
      enter: (n) => {
        if (n.name === "HorizontalRule") {
          sawRule = true;
        }
      },
    });
    expect(sawRule).toBe(true);
    // Premise: the break is below the fold and has NOT been drawn. Measured on
    // the widget's own stamp (`render`'s `el.className` in
    // thematic-break-widget.ts) — asserting the ERROR placeholder is absent here
    // would be vacuous, since nothing has thrown yet. Named by symbol rather
    // than by line: this selector only does its job while it still matches what
    // the widget stamps, and the bare `:40` it used to carry had already drifted
    // onto a blank line.
    expect(document.querySelector(".quoll-thematic-break")).toBeNull();

    vi.spyOn(console, "error").mockImplementation(() => {});
    const render = vi
      .spyOn(ThematicBreakWidget.prototype as unknown as { render: () => HTMLElement }, "render")
      .mockImplementation(() => {
        throw new Error("forced render failure");
      });
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    await settled();

    // The failing hook really ran, on the measure path, and was contained.
    expect(render).toHaveBeenCalled();
    render.mockRestore();
    expect(document.querySelector("[data-quoll-widget-error]")).not.toBeNull();

    // The editor still works: a later dispatch lands.
    view.dispatch({ changes: { from: 0, insert: "X" } });
    await settled();
    expect(view.state.doc.sliceString(0, 1)).toBe("X");
  } finally {
    view.destroy();
    parent.remove();
    vi.restoreAllMocks();
  }
});
