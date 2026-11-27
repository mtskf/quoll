// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { createSyntaxReveal } from "../../../src/webview/cm/decorations/orchestrator.js";
import { taskCheckboxReveal } from "../../../src/webview/cm/task-checkbox/task-checkbox-reveal.js";
import { settledMount } from "../helpers/settled-view.js";
import { withUnstarvedFrontier } from "../helpers/unstarved-frontier.js";

describe("CheckboxWidget — CM reconcile invocation contract (updateDOM reuse)", () => {
  // The direct-invocation tests in cm-task-checkbox-widget-toggle.test.ts call
  // `widget.updateDOM(dom, view, from)` DIRECTLY — they pin the METHOD's logic
  // (returns true, node identity preserved, from re-stamped) but not CM's
  // INVOCATION contract: that a real doc edit above a visible widget actually
  // drives the CM reconciler to REUSE the DOM node via updateDOM rather than
  // rebuild it via toDOM. `tsc` catches a signature change, but a value-level
  // regression (a future CM stops reusing the pool, or rebuilds instead of
  // updating) type-checks and silently defeats the optimization. This block
  // wires the REAL provider (`taskCheckboxReveal`) through the REAL
  // orchestrator ViewPlugin (`createSyntaxReveal`) into a live EditorView, so
  // the only synthetic part is the mount harness.
  //
  // Verified headless-viable: happy-dom (no layout) still runs the CM
  // decoration-reconcile pass — the mounted widget's span node is reused and
  // its dataset.from advances after an edit above. Non-vacuity was observed by
  // temporarily forcing updateDOM to return false (CM then rebuilds via toDOM →
  // a NEW node → the `toBe` identity assertion goes red).

  // Mounts "x\n- [ ] alpha" with the caret on line 1, applies the edit ABOVE the task
  // that the rows below share, and hands the observation its before/after spans.
  //
  // The edit's own transaction parses under CodeMirror's 20ms wall-clock budget, so
  // under CPU load it can stop short of the task line: the reveal then finds no Task
  // node and drops the widget, and no updateDOM reuse is left to observe. A settle after
  // the dispatch cannot repair that (the node is already gone, and a settle would mask a
  // broken updateDOM anyway), so a starved attempt is abandoned and re-run from scratch.
  function observeShift(
    observe: (view: EditorView, span1: HTMLElement | null, requireUnstarved: () => void) => void
  ): void {
    withUnstarvedFrontier({
      what: "the checkbox widget reconcile after an insert above it",
      mount: (parent) =>
        settledMount({
          parent,
          state: EditorState.create({
            doc: "x\n- [ ] alpha",
            // Caret placed OFF the task line so the reveal's selection guard emits the
            // widget (a caret on the task line renders raw `[ ]` source instead).
            selection: { anchor: 0 },
            extensions: [
              markdown({ base: markdownLanguage }),
              createSyntaxReveal([taskCheckboxReveal]),
            ],
          }),
        }),
      observe: (view, requireUnstarvedFrontier) => {
        const span1 = view.dom.querySelector<HTMLElement>(".quoll-task-checkbox");
        expect(span1).not.toBeNull();
        expect(span1?.dataset.from).toBe("4");
        // Real edit ABOVE the marker: prepend a 7-char line. The marker shifts by +7
        // while the caret stays off the task line (the task begins at offset 9), so the
        // widget stays revealed. The provider rebuilds a CheckboxWidget whose `from`
        // differs → eq() is false → CM MUST reconcile the existing tile via updateDOM.
        view.dispatch({ changes: { from: 0, insert: "prefix\n" } });
        requireUnstarvedFrontier();
        observe(view, span1, requireUnstarvedFrontier);
      },
    });
  }

  it("an insert above a revealed checkbox reuses the SAME span node, re-stamped to the new offset", () => {
    observeShift((view, span1) => {
      const span2 = view.dom.querySelector<HTMLElement>(".quoll-task-checkbox");
      expect(span2).not.toBeNull();
      // Node reuse: identical DOM node survived the edit (updateDOM returned
      // true). A rebuild via toDOM would hand back a different node → red.
      expect(span2).toBe(span1);
      // Re-stamped: the identity check above already ruled out toDOM (it would
      // have built a NEW node), so an advanced dataset.from on the SAME node can
      // only come from updateDOM's reuse body re-stamping it. A stale attribute
      // left by the original toDOM would still read "4", not "11".
      expect(span2?.dataset.from).toBe("11");
    });
  });

  it("the reused checkbox toggles the SHIFTED marker, not the stale pre-edit offset", () => {
    // Functional proof that the re-stamp is live, not cosmetic: after the shift,
    // a click must write to the marker at its NEW position.
    observeShift((view, span1, requireUnstarved) => {
      const span2 = view.dom.querySelector<HTMLElement>(".quoll-task-checkbox");
      expect(span2).toBe(span1); // same node — reconciled, not rebuilt
      // Marker `[` is now at 11; the toggle target is the middle char at 12.
      span2?.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true })
      );
      requireUnstarved(); // the toggle is a doc-changing transaction too
      expect(view.state.doc.sliceString(12, 13)).toBe("x");
    });
  });
});
