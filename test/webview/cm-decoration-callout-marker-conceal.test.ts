// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { blockStyle } from "../../src/webview/cm/decorations/block-style.js";
import {
  CALLOUT_MARKER_HIDDEN_CLASS,
  calloutMarkerConceal,
} from "../../src/webview/cm/decorations/callout.js";
import { calloutMarkerConcealField } from "../../src/webview/cm/decorations/callout-marker-conceal.js";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { quollSyntaxExclusionZones } from "../../src/webview/cm/decorations/orchestrator.js";
import { fullTree } from "./helpers/full-tree.js";

type SyntaxNode = ReturnType<typeof fullTree>["topNode"];

function stateFor(doc: string, caret: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [markdown({ base: markdownLanguage })],
  });
}

/** All Blockquote nodes in document (pre-order) order — [0] is the outermost. */
function blockquotes(state: EditorState): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  fullTree(state).iterate({
    enter: (n) => {
      if (n.name === "Blockquote") {
        out.push(n.node);
      }
    },
  });
  return out;
}

/** Flatten a DecorationSet to { from, to, cls } — a line deco is a point
 *  (from === to) carrying a class; a replace has from < to and an empty spec. */
function dump(set: DecorationSet): Array<{ from: number; to: number; cls?: string }> {
  const out: Array<{ from: number; to: number; cls?: string }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { class?: string };
    out.push({ from: iter.from, to: iter.to, cls: spec.class });
    iter.next();
  }
  return out;
}

describe("calloutMarkerConceal — pure predicate", () => {
  it("caret OUTSIDE the block returns the marker line span", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const node = blockquotes(state)[0];
    const marker = state.doc.line(1);
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toEqual({
      from: marker.from,
      to: marker.to,
    });
  });

  it("caret INSIDE the block returns null (revealed)", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = stateFor(doc, 3); // caret in `[!NOTE]`
    const node = blockquotes(state)[0];
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toBeNull();
  });

  it("a marker-only callout (no body) never conceals, even caret-outside", () => {
    const doc = "> [!NOTE]\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const node = blockquotes(state)[0];
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toBeNull();
  });

  it("a nested inner marker never conceals (only the outermost is a callout)", () => {
    const doc = "> [!WARNING]\n> > [!NOTE]\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const inner = blockquotes(state)[1]; // the `> >` inner quote
    expect(calloutMarkerConceal(state.doc, state.selection, inner)).toBeNull();
  });

  it("an unknown `[!FOO]` is not a callout → null", () => {
    const doc = "> [!FOO]\n> body\n\npara";
    const state = stateFor(doc, doc.indexOf("para") + 1);
    const node = blockquotes(state)[0];
    expect(calloutMarkerConceal(state.doc, state.selection, node)).toBeNull();
  });
});

describe("calloutMarkerConcealField — StateField", () => {
  function fieldState(doc: string, caret: number): EditorState {
    return EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [markdown({ base: markdownLanguage }), calloutMarkerConcealField],
    });
  }

  it("caret OUTSIDE emits the replace + hidden line class and publishes the zone", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = fieldState(doc, doc.indexOf("para") + 1);
    const marker = state.doc.line(1);
    const decos = dump(state.field(calloutMarkerConcealField).decorations);
    // A replace over the whole marker line [from, to).
    expect(decos).toContainEqual({ from: marker.from, to: marker.to, cls: undefined });
    // A zero-height line class at the line start.
    expect(
      decos.some(
        (d) =>
          d.from === marker.from && d.to === marker.from && d.cls === CALLOUT_MARKER_HIDDEN_CLASS
      )
    ).toBe(true);
    // The marker span is published to the exclusion facet.
    expect(state.facet(quollSyntaxExclusionZones)).toContainEqual({
      from: marker.from,
      to: marker.to,
    });
  });

  it("caret INSIDE emits nothing and publishes no zone", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state = fieldState(doc, 3); // caret in `[!NOTE]`
    expect(state.field(calloutMarkerConcealField).decorations.size).toBe(0);
    expect(state.facet(quollSyntaxExclusionZones)).toEqual([]);
  });

  it("a selection move outside→inside flips the conceal off (non-vacuous)", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    let state = fieldState(doc, doc.indexOf("para") + 1); // outside
    expect(state.field(calloutMarkerConcealField).decorations.size).toBeGreaterThan(0);
    state = state.update({ selection: { anchor: 3 } }).state; // into `[!NOTE]`
    expect(state.field(calloutMarkerConcealField).decorations.size).toBe(0);
    expect(state.facet(quollSyntaxExclusionZones)).toEqual([]);
  });

  it("an outside→outside move keeps the SAME exclusion-facet value identity (F3)", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const state1 = fieldState(doc, doc.indexOf("para") + 1); // outside
    const state2 = state1.update({ selection: { anchor: doc.indexOf("para") + 2 } }).state; // still outside
    // The field returns `prev` verbatim (markers content-equal), so CM reuses the
    // combined facet value by reference — no churn that would make block-style
    // rebuild noisily on a plain caret move.
    expect(state2.facet(quollSyntaxExclusionZones)).toBe(state1.facet(quollSyntaxExclusionZones));
  });

  // Crash regression (v2 Finding 2): a marker line with inline markup
  // (`> [!TIP] **title**`) would, under an inline-provider design, leave two
  // overlapping Decoration.replace on the line (the `>` hide + the `**` hide) and
  // CodeMirror throws. The StateField owns the WHOLE line as ONE replace + publishes
  // its span, so quollSyntaxReveal's inline marks are arbitrated away — mounting the
  // full stack must NOT throw.
  it("mounts `> [!TIP] **title**` with the full reveal stack without throwing", () => {
    const doc = "> [!TIP] **title**\n> body\n\npara";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let view: EditorView | null = null;
    expect(() => {
      view = new EditorView({
        state: EditorState.create({
          doc,
          selection: EditorSelection.single(doc.indexOf("para") + 1), // caret outside
          extensions: [
            markdown({ base: markdownLanguage }),
            quollSyntaxReveal(),
            blockStyle,
            calloutMarkerConcealField,
          ],
        }),
        parent,
      });
    }).not.toThrow();
    // The field concealed the formatted-title marker row with a single replace.
    const v = view as unknown as EditorView;
    const marker = v.state.doc.line(1);
    const decos = dump(v.state.field(calloutMarkerConcealField).decorations);
    expect(decos).toContainEqual({ from: marker.from, to: marker.to, cls: undefined });
    v.destroy();
  });
});
