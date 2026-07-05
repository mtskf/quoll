// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollSyntaxExclusionZones } from "../../src/webview/cm/decorations/orchestrator.js";
import { headingRhythmFoldGutterLineClass, quollFolding } from "../../src/webview/cm/fold/index.js";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy(); // undisposed views leak real timers across tests
  view = null;
});

function mountDoc(doc: string, extra: readonly unknown[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), quollFolding(), ...(extra as never[])],
    }),
  });
  ensureSyntaxTree(v.state, v.state.doc.length, 5000);
  return v;
}

describe("headingRhythmFoldGutterLineClass — per-level gutter tag for the rhythm offset", () => {
  // Pins the HEADING-DETECTION contract that drives the gutter `padding-top` offset
  // matching the heading line's own `--quoll-heading-space-*` rhythm padding. The
  // PIXEL alignment itself is real-browser-only (happy-dom has no layout) — this
  // asserts ONLY that every rhythm-eligible heading line (and no other) carries the
  // right `quoll-fold-heading-rhythm-{level}` gutter tag, in lock-step with the
  // `.cm-line.quoll-heading-rhythm-{level}` padding the content half adds.
  function taggedClassByLine(doc: string, extra: readonly unknown[] = []): Map<number, string> {
    view = mountDoc(doc, extra);
    const set = view.state.field(headingRhythmFoldGutterLineClass);
    const byLine = new Map<number, string>();
    const cursor = set.iter();
    while (cursor.value) {
      // gutterLineClass markers are point ranges at the line start.
      expect(cursor.from).toBe(cursor.to);
      const line = view.state.doc.lineAt(cursor.from);
      expect(cursor.from).toBe(line.from);
      byLine.set(line.number, (cursor.value as { elementClass: string }).elementClass);
      cursor.next();
    }
    return byLine;
  }

  it("tags each level 1-6 heading line and skips line-1 / paragraph / nested", () => {
    // Line 1 intro (paragraph); 2 H1; 3 H2; 4 H3; 5 H4; 6 H5; 7 H6; 8 body;
    // 9 `> # nested` (blockquote heading). The H1 sits on line 2 (NOT line 1) so
    // it is eligible; first-line suppression is covered by its own test below.
    const byLine = taggedClassByLine(
      "intro\n# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\nbody\n> # nested\n"
    );
    expect(byLine.get(2)).toBe("quoll-fold-heading-rhythm-1");
    expect(byLine.get(3)).toBe("quoll-fold-heading-rhythm-2");
    expect(byLine.get(4)).toBe("quoll-fold-heading-rhythm-3");
    expect(byLine.get(5)).toBe("quoll-fold-heading-rhythm-4");
    expect(byLine.get(6)).toBe("quoll-fold-heading-rhythm-5");
    expect(byLine.get(7)).toBe("quoll-fold-heading-rhythm-6");
    // Paragraph lines and the blockquote-nested heading are untagged.
    expect(byLine.has(1)).toBe(false);
    expect(byLine.has(8)).toBe(false);
    expect(byLine.has(9)).toBe(false);
    expect(byLine.size).toBe(6);
  });

  it("suppresses a heading on physical line 1 (lock-step with the content half)", () => {
    const byLine = taggedClassByLine("# Top\n\nbody\n");
    expect(byLine.size).toBe(0);
  });

  it("does NOT tag a heading line inside a quollSyntaxExclusionZones span", () => {
    // Same fixture as the content-half exclusion test: `title: y\n---` parses as a
    // SetextHeading2 on line 3, off physical line 1. Inside a zone → no tag; the
    // gutter offset must skip it in lock-step or a REVEALED frontmatter heading
    // would drop the chevron by the rhythm gap.
    const doc = "intro\n\ntitle: y\n---";
    const byLine = taggedClassByLine(doc, [
      quollSyntaxExclusionZones.of([{ from: 0, to: doc.length }]),
    ]);
    expect(byLine.size).toBe(0);
    // Control: with NO zone the same Setext line IS tagged level 2 (line 3).
    const control = taggedClassByLine(doc);
    expect(control.get(3)).toBe("quoll-fold-heading-rhythm-2");
    expect(control.size).toBe(1);
  });

  it("keeps the field value BY REFERENCE across a selection-only transaction", () => {
    // The StateField analog of the content revert-check: a selection-only dispatch
    // (no doc / tree / facet change) must return the SAME RangeSet instance — a
    // non-vacuous guard that no `selectionSet` clause crept into `update`. Removing
    // the early-return `return value` would rebuild a fresh (non-identical) set.
    view = mountDoc("intro\n# One\n## Two\n");
    const before = view.state.field(headingRhythmFoldGutterLineClass);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    const after = view.state.field(headingRhythmFoldGutterLineClass);
    expect(after).toBe(before);
  });

  it("recomputes the tag set when the exclusion-zone facet flips with no doc change", () => {
    // Pins the facet-change update trigger: a zone contributor that flips on a
    // selection-only transaction (no doc edit, no tree change) must still update the
    // tags. Drive the zone via a StateEffect so the flip carries neither docChanged
    // nor a tree change (mirrors listFoldGutterLineClass's facet-flip guard).
    const setZones = StateEffect.define<readonly { from: number; to: number }[]>();
    const zoneField = StateField.define<readonly { from: number; to: number }[]>({
      create: () => [],
      update(value, tr) {
        for (const e of tr.effects) {
          if (e.is(setZones)) {
            return e.value;
          }
        }
        return value;
      },
      provide: (f) => quollSyntaxExclusionZones.from(f),
    });
    view = mountDoc("intro\n# One\n## Two\n", [zoneField]);
    const tagged = (): Set<number> => {
      const s = new Set<number>();
      const c = (view as EditorView).state.field(headingRhythmFoldGutterLineClass).iter();
      while (c.value) {
        s.add((view as EditorView).state.doc.lineAt(c.from).number);
        c.next();
      }
      return s;
    };
    expect(tagged()).toEqual(new Set([2, 3])); // no zones → both headings tagged
    // Flip a zone over line 2 with NO doc change; the tag set must drop line 2.
    view.dispatch({ effects: setZones.of([{ from: 0, to: view.state.doc.line(2).to }]) });
    expect(tagged()).toEqual(new Set([3]));
  });
});
