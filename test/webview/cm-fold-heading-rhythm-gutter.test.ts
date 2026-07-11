// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTreeAvailable } from "@codemirror/language";
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

// A contributor that churns the facet reference every transaction (mimics
// calloutMarkerConcealField, which returns a fresh zones array each docChanged),
// while keeping the CONTENT fixed to `content`.
function churningZoneField(content: readonly { from: number; to: number }[]) {
  return StateField.define<readonly { from: number; to: number }[]>({
    create: () => content.map((z) => ({ ...z })),
    update: () => content.map((z) => ({ ...z })), // fresh array + fresh objects every tx
    provide: (f) => quollSyntaxExclusionZones.from(f),
  });
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

  it("does NOT tag a nascent lone `-` setext (lock-step with the demoted font)", () => {
    // "intro\n\nFoo\n-": SetextHeading2 with a lone `-` underline reads as a bullet
    // list in progress, not a heading — the gutter rhythm tag must be suppressed in
    // lock-step with the content-half padding and the font de-style.
    const byLine = taggedClassByLine("intro\n\nFoo\n-");
    expect(byLine.size).toBe(0);
    // Control: a real multi-char `---` heading keeps its gutter tag (line 3).
    const control = taggedClassByLine("intro\n\nFoo\n---");
    expect(control.get(3)).toBe("quoll-fold-heading-rhythm-2");
    expect(control.size).toBe(1);
  });

  it("does NOT tag a lone `-`/`=` with a mid-typing trailing space, but DOES tag a real `--`/`==` (boundary pair)", () => {
    // "intro\n\nFoo\n- ": the HeaderMark excludes the trailing space, so the
    // underline is still length 1 → nascent → suppressed (boundary neighbor of
    // the 2-char case). Revert-check: relaxing `mark.to - mark.from === 1` to
    // `=== 2` reds the trailing-space case; relaxing to `>= 1` reds the two-char
    // case. The length gate is char-agnostic; `==` tags level 1, `--` level 2.
    for (const u of ["-", "="]) {
      expect(taggedClassByLine(`intro\n\nFoo\n${u} `).size).toBe(0);
      const twoChar = taggedClassByLine(`intro\n\nFoo\n${u}${u}`);
      const cls = u === "=" ? "quoll-fold-heading-rhythm-1" : "quoll-fold-heading-rhythm-2";
      expect(twoChar.get(3)).toBe(cls);
      expect(twoChar.size).toBe(1);
    }
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

  it("keeps the field value by reference on a selection-only tx even when the zone facet churns its reference (content unchanged)", () => {
    view = mountDoc("intro\n## a\n\npara\n\n## gone\n", [churningZoneField([])]);
    const before = view.state.field(headingRhythmFoldGutterLineClass);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    const after = view.state.field(headingRhythmFoldGutterLineClass);
    expect(after).toBe(before); // fix: content-equal churn → return value; bug: rebuilt (new ref)
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

  // { retry } — mitigates the load-sensitive bounded≡full flake (LEARNING.md).
  describe("bounded recompute (keystroke path) — stays equal to a full rebuild", {
    retry: 2,
  }, () => {
    // Serialize the whole RangeSet ({from,to,cls}) and compare arrays vs the oracle
    // (Codex #2 — a by-line Map hides duplicate/order/extra ranges a double-add adds).
    function serializeField(v: EditorView): { from: number; to: number; cls: string }[] {
      const out: { from: number; to: number; cls: string }[] = [];
      const cursor = v.state.field(headingRhythmFoldGutterLineClass).iter();
      while (cursor.value) {
        out.push({
          from: cursor.from,
          to: cursor.to,
          cls: (cursor.value as { elementClass: string }).elementClass,
        });
        cursor.next();
      }
      return out;
    }
    function oracle(doc: string): { from: number; to: number; cls: string }[] {
      const fresh = mountDoc(doc);
      const ser = serializeField(fresh);
      fresh.destroy();
      return ser;
    }
    function classAtLine(v: EditorView, lineNo: number): string | undefined {
      return serializeField(v).find((r) => v.state.doc.lineAt(r.from).number === lineNo)?.cls;
    }
    function expectBoundedEqualsFull(): void {
      expect(syntaxTreeAvailable(view!.state, view!.state.doc.length)).toBe(true);
      expect(serializeField(view!)).toEqual(oracle(view!.state.doc.toString()));
    }

    it("re-tags a heading whose level is edited in place (## → ####)", () => {
      view = mountDoc("intro\n## Two\n");
      expect(classAtLine(view, 2)).toBe("quoll-fold-heading-rhythm-2");
      const pos = view.state.doc.toString().indexOf("## Two") + 1;
      view.dispatch({ changes: { from: pos, insert: "##" } }); // "## Two" → "#### Two"
      expect(classAtLine(view, 2)).toBe("quoll-fold-heading-rhythm-4");
      expectBoundedEqualsFull();
    });

    it("tags a newly typed heading and drops one whose marker is deleted", () => {
      view = mountDoc("intro\n\npara\n\n## gone\n");
      const para = view.state.doc.toString().indexOf("para");
      view.dispatch({ changes: { from: para, insert: "### " } }); // "para" → "### para"
      const paraLine = view.state.doc.lineAt(view.state.doc.toString().indexOf("para")).number;
      expect(classAtLine(view, paraLine)).toBe("quoll-fold-heading-rhythm-3");
      expectBoundedEqualsFull();
      const gone = view.state.doc.toString().indexOf("## gone");
      view.dispatch({ changes: { from: gone, to: gone + 3, insert: "" } }); // strip "## "
      const goneLine = view.state.doc.lineAt(view.state.doc.toString().indexOf("gone")).number;
      expect(classAtLine(view, goneLine)).toBeUndefined();
      expectBoundedEqualsFull();
    });

    it("tags a Setext heading whose === underline is typed lines below (up-walk)", () => {
      // rhythm covers Setext (level ≤ 2). The change (the `===` line) sits BELOW the
      // title line the marker rides, so a naive ±1 window would miss it.
      view = mountDoc("intro\n\nfoo\nbar\nbaz\n");
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: "===\n" } }); // foo/bar/baz → Setext H1
      expect(classAtLine(view, 3)).toBe("quoll-fold-heading-rhythm-1"); // title line (foo)
      expectBoundedEqualsFull();
    });

    it("flips first-physical-line suppression when a blank line is inserted above / deleted (topmost heading)", () => {
      view = mountDoc("# Top\n\nbody\n");
      expect(serializeField(view)).toEqual([]); // line-1 heading suppressed
      view.dispatch({ changes: { from: 0, insert: "\n" } }); // "# Top" now line 2
      expect(classAtLine(view, 2)).toBe("quoll-fold-heading-rhythm-1");
      expectBoundedEqualsFull();
      view.dispatch({ changes: { from: 0, to: 1, insert: "" } }); // back to line 1
      expect(serializeField(view)).toEqual([]);
      expectBoundedEqualsFull();
    });

    it("suppresses a heading pushed to physical line 1 by deleting the line above (Codex #4)", () => {
      // The deletion path (fromB === toB): "intro\n# H" — "# H" is line 2 (eligible).
      // Delete the whole "intro\n" first line so "# H" becomes physical line 1 →
      // suppressed. The changed range starts at offset 0 (a collapsing deletion), so
      // the bounded window's up-walk begins at the new line 1.
      view = mountDoc("intro\n# H\n\nbody\n");
      expect(classAtLine(view, 2)).toBe("quoll-fold-heading-rhythm-1");
      view.dispatch({ changes: { from: 0, to: "intro\n".length, insert: "" } }); // drop line 1
      expect(serializeField(view)).toEqual([]); // "# H" now line 1 → suppressed
      expectBoundedEqualsFull();
    });

    it("recomputes both blocks of a multi-range (multi-cursor) transaction", () => {
      view = mountDoc("intro\n## a\n\nbody\n\n### b\n");
      const aFrom = view.state.doc.toString().indexOf("## a");
      const bFrom = view.state.doc.toString().indexOf("### b");
      view.dispatch({
        changes: [
          { from: aFrom, to: aFrom + 1, insert: "" }, // "## a" → "# a"
          { from: bFrom, to: bFrom + 1, insert: "" }, // "### b" → "## b"
        ],
      });
      expect(classAtLine(view, 2)).toBe("quoll-fold-heading-rhythm-1");
      expect(classAtLine(view, 6)).toBe("quoll-fold-heading-rhythm-2");
      expectBoundedEqualsFull();
    });

    it("stays correct on a docChanged while the zone facet churns its reference (bounded path exercised in production-like churn)", () => {
      view = mountDoc("intro\n## a\n\npara\n\n## gone\n", [churningZoneField([])]);
      const para = view.state.doc.toString().indexOf("para");
      view.dispatch({ changes: { from: para, insert: "### " } }); // "para" → "### para"
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      // Serialize this field, compare to a fresh full build over the same doc + empty zones.
      const ser = (v: EditorView) => {
        const out: { from: number; to: number; cls: string }[] = [];
        const c = v.state.field(headingRhythmFoldGutterLineClass).iter();
        while (c.value) {
          out.push({
            from: c.from,
            to: c.to,
            cls: (c.value as { elementClass: string }).elementClass,
          });
          c.next();
        }
        return out;
      };
      const fresh = mountDoc(view.state.doc.toString());
      expect(ser(view)).toEqual(ser(fresh));
      fresh.destroy();
    });

    it("recomputes a far heading when the exclusion-zone facet flips IN THE SAME docChanged (Codex #3)", () => {
      // A docChanged that ALSO flips the facet must full-rebuild (the `facetChanged`
      // guard), because a zone flip changes eligibility OUTSIDE the changed range.
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
      view = mountDoc("intro\n## far\n\n## near\n", [zoneField]);
      expect(serializeField(view).length).toBe(2); // both headings tagged, no zones
      const near = view.state.doc.toString().indexOf("near");
      view.dispatch({
        changes: { from: near, insert: "X" }, // edit the bottom block
        effects: setZones.of([{ from: 0, to: view.state.doc.line(2).to }]), // zone over "## far"
      });
      // "## far" is zoned out despite the edit being far from it — the facetChanged
      // full-rebuild must catch it (a bounded-only path would strand its marker).
      const lines = new Set(serializeField(view).map((r) => view!.state.doc.lineAt(r.from).number));
      const nearLine = view.state.doc.lineAt(view.state.doc.toString().indexOf("near")).number;
      expect(lines).toEqual(new Set([nearLine]));
    });
  });

  // The bounded recompute (expandToEnclosingBlock) assumes a heading's rhythm-
  // eligibility (top-level + off physical line 1 + not in a zone) can only change from
  // WITHIN its own run. A STRUCTURAL reparse breaks that: un-listing re-contexts a
  // nested heading to top-level; an unclosed fence swallows it; a multi-line interior
  // edit promotes a far heading. `touchesStructuralReparse` routes those to a FULL
  // rebuild. Each case is bounded==oracle AND RED against the guard-less field.
  // { retry } — mitigates the load-sensitive bounded≡full flake (LEARNING.md).
  describe("bounded ≡ full-rebuild under structural reparse", { retry: 2 }, () => {
    function serializeGutter(v: EditorView): { from: number; to: number; cls: string }[] {
      const out: { from: number; to: number; cls: string }[] = [];
      const cursor = v.state.field(headingRhythmFoldGutterLineClass).iter();
      while (cursor.value) {
        out.push({
          from: cursor.from,
          to: cursor.to,
          cls: (cursor.value as { elementClass: string }).elementClass,
        });
        cursor.next();
      }
      return out;
    }
    function oracle(doc: string): { from: number; to: number; cls: string }[] {
      const fresh = mountDoc(doc);
      expect(syntaxTreeAvailable(fresh.state, fresh.state.doc.length)).toBe(true);
      const ser = serializeGutter(fresh);
      fresh.destroy();
      return ser;
    }
    function expectBoundedEqualsFull(): void {
      expect(syntaxTreeAvailable(view!.state, view!.state.doc.length)).toBe(true);
      expect(serializeGutter(view!)).toEqual(oracle(view!.state.doc.toString()));
    }

    it("an unclosed fence inserted above a heading swallows it (SHAPE fence)", () => {
      view = mountDoc("intro\n\n# h\n");
      expect(serializeGutter(view).length).toBe(1); // # h (line 3) tagged
      view.dispatch({ changes: { from: 0, insert: "```\n" } });
      expect(serializeGutter(view)).toEqual([]);
      expectBoundedEqualsFull();
    });

    it("B3: un-listing a parent promotes a nested heading to top-level (SHAPE list marker)", () => {
      // `  # h` nested in the list item `- a` is NOT rhythm-eligible (not top-level).
      // Deleting the `- ` marker re-contexts it to a top-level ATX heading → eligible.
      // The edit is far from `# h` (bounded would strand it); SHAPE catches old `- a`.
      view = mountDoc("- a\n\n  # h\n");
      expect(serializeGutter(view)).toEqual([]); // nested heading not eligible
      view.dispatch({ changes: { from: 0, to: 2, insert: "" } }); // "- a" → "a"
      expect(serializeGutter(view).length).toBe(1); // "  # h" now top-level → eligible
      expectBoundedEqualsFull();
    });

    it("B: a multi-line interior insert promotes a far heading (NEWLINE-DELTA only)", () => {
      // The insertion point is the END of the non-blank "  midX" line, so BOTH endpoint
      // lines stay "  midX" (non-blank, indent "  ") and the new-slice carries no marker
      // shape — SHAPE / BLANK-FLIP / INDENT-DELTA all miss it. Only the inserted "\n\n"
      // (NEWLINE-DELTA) catches it. Inserting a blank line + a col-0 line ("BBB") after
      // "  midX" TERMINATES the loose list item, so the far "  # h" re-contexts from a
      // ListItem-nested heading (not rhythm-eligible) to a top-level ATX heading
      // (eligible) — a flip the bounded window (which stops at the interior blank) misses.
      view = mountDoc("- item\n\n  midX\n\n  # h\n");
      expect(serializeGutter(view)).toEqual([]); // # h nested → not eligible
      const midEnd = view.state.doc.toString().indexOf("  midX") + "  midX".length;
      view.dispatch({ changes: { from: midEnd, insert: "\n\nBBB" } }); // terminate the list
      expect(serializeGutter(view).length).toBe(1); // "  # h" promoted → eligible
      expectBoundedEqualsFull();
    });

    it("C: an interior blank + col-0 line terminates a list, flipping a far heading (NEWLINE-DELTA)", () => {
      // `  aXb` → `  a\n\nx\n  b` inserts an interior blank + a col-0 line inside the
      // list item, terminating it so the following `  # h` promotes to top-level.
      view = mountDoc("- item\n\n  aXb\n\n  # h\n");
      expect(serializeGutter(view)).toEqual([]);
      const x = view.state.doc.toString().indexOf("aXb") + 1; // the "X"
      view.dispatch({ changes: { from: x, to: x + 1, insert: "\n\nx\n  " } }); // "  aXb" → "  a\n\nx\n  b"
      expect(serializeGutter(view).length).toBe(1);
      expectBoundedEqualsFull();
    });
  });
});
