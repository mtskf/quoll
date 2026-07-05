// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  ensureSyntaxTree,
  foldAll,
  foldable,
  foldCode,
  foldEffect,
  foldedRanges,
  syntaxTreeAvailable,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
} from "@codemirror/language";
import { EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollSyntaxExclusionZones } from "../../src/webview/cm/decorations/orchestrator.js";
import {
  CHEVRON_DOWN_PATH,
  ELLIPSIS_DOT_CX,
  foldPlaceholderDOM,
  headingFoldGutterLineClass,
  listFoldGutterLineClass,
  markerDOM,
  quollFolding,
  quollFoldKeymap,
  quollFoldKeymapExtension,
} from "../../src/webview/cm/fold/index.js";
import { frontmatterBlockField } from "../../src/webview/cm/frontmatter/index.js";

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

describe("quollFolding — list folding (delegated to lang-markdown)", () => {
  it("a nested-list parent line is foldable via foldCode (range from lang-markdown)", () => {
    view = mountDoc("- a\n  - b\n  - c\n- d\n");
    view.dispatch({ selection: EditorSelection.cursor(0) }); // caret on "- a"
    expect(foldCode(view)).toBe(true);
    expect(foldedRanges(view.state).size).toBe(1);
  });
});

describe("quollFolding — native auto-unfold (foldState.clearTouchedFolds)", () => {
  it("auto-unfolds when the selection lands inside a folded range", () => {
    view = mountDoc("- a\n  - b\n  - c\n- d\n");
    const line = view.state.doc.lineAt(0);
    const r = foldable(view.state, line.from, line.to);
    view.dispatch({ effects: foldEffect.of(r!) });
    expect(foldedRanges(view.state).size).toBe(1);
    const inside = view.state.doc.toString().indexOf("- b"); // inside the fold
    view.dispatch({ selection: EditorSelection.cursor(inside) });
    expect(foldedRanges(view.state).size).toBe(0); // native clear
  });

  it("auto-unfolds when a real edit (change + caret) lands inside a folded range", () => {
    view = mountDoc("- a\n  - b\n  - c\n- d\n");
    const line = view.state.doc.lineAt(0);
    const r = foldable(view.state, line.from, line.to);
    view.dispatch({ effects: foldEffect.of(r!) });
    const inside = view.state.doc.toString().indexOf("- b");
    // Real typing carries BOTH a change and a selection at the edit point; the
    // selection head inside the fold fires native clearTouchedFolds. (A
    // change-ONLY transaction would map the fold and keep it folded — verified
    // fact #2 — so this test MUST include the selection to mirror real input.)
    view.dispatch({
      changes: { from: inside, insert: "X" },
      selection: EditorSelection.cursor(inside + 1),
    });
    expect(foldedRanges(view.state).size).toBe(0);
  });

  it("does NOT unfold when the caret stays outside every fold", () => {
    view = mountDoc("- a\n  - b\n- d\n");
    const line = view.state.doc.lineAt(0);
    const r = foldable(view.state, line.from, line.to);
    view.dispatch({ effects: foldEffect.of(r!) });
    const dPos = view.state.doc.toString().indexOf("- d");
    view.dispatch({ selection: EditorSelection.cursor(dPos) });
    expect(foldedRanges(view.state).size).toBe(1); // still folded
  });
});

describe("quollFolding — block-widget overlap is safe (review finding #5)", () => {
  it("folding over block widgets does not throw; widgets hide while folded, restore after unfold", async () => {
    // Mount with the real table + image block fields so a fold can overlap them.
    const { tableBlockField } = await import("../../src/webview/cm/table/index.js");
    const { imageBlockField } = await import("../../src/webview/cm/image/index.js");
    const doc = "# H\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![x](y.png)\n";
    view = mountDoc(doc, [tableBlockField, imageBlockField]);
    // `.quoll-block` is the shared block-widget root class (styles-contract.test.ts).
    // If the real table/image widget root class differs, point widgetSel at it.
    const widgetSel = ".quoll-block";
    const range = { from: view.state.doc.lineAt(0).to, to: view.state.doc.length };
    // Fold the whole heading section (spans the table + image block widgets).
    expect(() => view!.dispatch({ effects: foldEffect.of(range) })).not.toThrow();
    expect(foldedRanges(view.state).size).toBe(1);
    // Our custom inline placeholder (foldPlaceholderDOM) replaces CM's default
    // `.cm-foldPlaceholder` box, so the collapsed region renders our pill class.
    expect(view.dom.querySelector(".quoll-fold-placeholder")).not.toBeNull();
    // While folded the inner block widgets are NOT built (the fold replace
    // supersedes — CM's ContentBuilder never descends into the folded range).
    expect(view.dom.querySelector(widgetSel)).toBeNull();
    // Unfolding restores them.
    view.dispatch({ effects: unfoldEffect.of(range) });
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.dom.querySelector(widgetSel)).not.toBeNull();
  });
});

describe("markerDOM — Lucide chevron SVG (replaces ⌄ / › glyphs)", () => {
  it("renders one chevron-down SVG path in BOTH states (no text glyph)", () => {
    for (const open of [true, false]) {
      const el = markerDOM(open);
      expect(el.classList.contains("quoll-fold-marker")).toBe(true);
      const svg = el.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg!.getAttribute("fill")).toBe("none");
      expect(svg!.getAttribute("stroke")).toBe("currentColor");
      expect(svg!.getAttribute("aria-hidden")).toBe("true");
      const path = svg!.querySelector("path");
      expect(path).not.toBeNull();
      expect(path!.getAttribute("d")).toBe(CHEVRON_DOWN_PATH);
      // Single icon used for both states — no second path, no text glyph.
      expect(svg!.querySelectorAll("path").length).toBe(1);
      expect(el.textContent).toBe("");
    }
  });

  it("toggles the --folded class (rotated right) only when folded, keeps the title tooltip", () => {
    const openEl = markerDOM(true);
    expect(openEl.classList.contains("quoll-fold-marker--folded")).toBe(false);
    expect(openEl.title).toBe("Fold");

    const foldedEl = markerDOM(false);
    expect(foldedEl.classList.contains("quoll-fold-marker--folded")).toBe(true);
    expect(foldedEl.title).toBe("Unfold");
  });
});

describe("foldPlaceholderDOM — inline collapsed-region pill (Lucide ellipsis)", () => {
  // `state.phrase` returns its key verbatim absent a translation, so a minimal
  // stub is enough to exercise the builder's title / aria-label wiring.
  const fakeView = { state: { phrase: (s: string) => s } } as unknown as EditorView;

  it("renders a three-dot Lucide ellipsis SVG in a pill — not CM's default box", () => {
    const el = foldPlaceholderDOM(fakeView, () => {});
    expect(el.classList.contains("quoll-fold-placeholder")).toBe(true);
    // We do NOT reuse `cm-foldPlaceholder`, so CM's bordered-grey box theme never
    // matches — the pill owns its entire look.
    expect(el.classList.contains("cm-foldPlaceholder")).toBe(false);

    const svg = el.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg!.getAttribute("fill")).toBe("none");
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");

    const dots = [...svg!.querySelectorAll("circle")];
    expect(dots.length).toBe(3);
    expect(dots.map((d) => d.getAttribute("cx"))).toEqual(ELLIPSIS_DOT_CX.map(String));
    for (const d of dots) {
      expect(d.getAttribute("cy")).toBe("12");
      expect(d.getAttribute("r")).toBe("1");
    }
    // No text glyph — the old default rendered a literal "…".
    expect(el.textContent).toBe("");
  });

  it("wires the supplied onclick (click-to-unfold) and keeps the unfold tooltip + aria-label", () => {
    let clicked = 0;
    const el = foldPlaceholderDOM(fakeView, () => {
      clicked += 1;
    });
    expect(el.title).toBe("unfold");
    expect(el.getAttribute("aria-label")).toBe("folded content");
    el.click();
    expect(clicked).toBe(1);
  });
});

describe("headingFoldGutterLineClass — per-level gutter tag for the first-row cap", () => {
  // Pins the HEADING-DETECTION contract that drives the per-level `--quoll-fold-row-scale`
  // cap (the PIXEL alignment itself is real-browser-only — happy-dom has no layout).
  function taggedClassByLine(doc: string): Map<number, string> {
    view = mountDoc(doc);
    const set = view.state.field(headingFoldGutterLineClass);
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

  it("tags H1/H2/H3 lines with their level class and nothing else", () => {
    // Lines 1-3 headings; line 4 H4 (body-size font, no cap needed); lines 5-7 body+list.
    const byLine = taggedClassByLine(
      "# One\n## Two\n### Three\n#### Four\nbody text\n- item\n  - child\n"
    );
    expect(byLine.get(1)).toBe("quoll-fold-heading-1");
    expect(byLine.get(2)).toBe("quoll-fold-heading-2");
    expect(byLine.get(3)).toBe("quoll-fold-heading-3");
    // H4 and every non-heading line are untagged (default scale 1 = one body row).
    expect(byLine.has(4)).toBe(false);
    expect(byLine.has(5)).toBe(false);
    expect(byLine.has(6)).toBe(false);
    expect(byLine.has(7)).toBe(false);
    expect(byLine.size).toBe(3);
  });

  it("tags a Setext heading underlined with === as level 1", () => {
    // Setext H1: the title line carries SetextHeading1 (heading1 tag → 1.8em).
    const byLine = taggedClassByLine("Title line\n===\n\nbody\n");
    expect(byLine.get(1)).toBe("quoll-fold-heading-1");
    expect(byLine.size).toBe(1);
  });

  // The keystroke path recomputes ONLY the changed block (bounded), not the whole
  // syntax tree. These pin that the bounded result stays byte-identical to a full
  // rebuild across heading insert / remove / edit — including the multi-line Setext
  // boundary a naive ±1-line window would miss.
  describe("bounded recompute (keystroke path) — stays equal to a full rebuild", () => {
    function fieldClassesByLine(v: EditorView): Map<number, string> {
      const set = v.state.field(headingFoldGutterLineClass);
      const byLine = new Map<number, string>();
      const cursor = set.iter();
      while (cursor.value) {
        expect(cursor.from).toBe(cursor.to); // point ranges at line starts
        const line = v.state.doc.lineAt(cursor.from);
        expect(cursor.from).toBe(line.from);
        byLine.set(line.number, (cursor.value as { elementClass: string }).elementClass);
        cursor.next();
      }
      return byLine;
    }

    // The full-rebuild oracle: the field freshly created over `doc` (field.create →
    // whole-tree walk). The bounded update must reproduce it.
    function fullRebuildByLine(doc: string): Map<number, string> {
      const fresh = mountDoc(doc);
      const byLine = fieldClassesByLine(fresh);
      fresh.destroy();
      return byLine;
    }

    function expectEqualByLine(a: Map<number, string>, b: Map<number, string>): void {
      expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
    }

    it("re-tags a line whose heading level is edited in place (# → ###)", () => {
      view = mountDoc("# One\nbody\n");
      expect(fieldClassesByLine(view).get(1)).toBe("quoll-fold-heading-1");
      // Insert "##" after the first "#" so "# One" becomes "### One".
      view.dispatch({ changes: { from: 1, insert: "##" } });
      const byLine = fieldClassesByLine(view);
      expect(byLine.get(1)).toBe("quoll-fold-heading-3");
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });

    it("tags a newly inserted heading line and drops one deleted mid-doc", () => {
      view = mountDoc("# Keep\n\npara\n\n## Gone\n");
      // Turn "para" into a heading, and delete the "## " off "## Gone".
      view.dispatch({ changes: { from: 8, insert: "### " } }); // "para" → "### para"
      let byLine = fieldClassesByLine(view);
      expect(byLine.get(3)).toBe("quoll-fold-heading-3");
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));

      // Remove the "## " marker from the last heading → it becomes body text.
      const gone = view.state.doc.toString().indexOf("## Gone");
      view.dispatch({ changes: { from: gone, to: gone + 3, insert: "" } });
      byLine = fieldClassesByLine(view);
      const goneLine = view.state.doc.lineAt(view.state.doc.toString().indexOf("Gone")).number;
      expect(byLine.has(goneLine)).toBe(false);
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });

    it("tags the FIRST line when a Setext underline is typed lines below it", () => {
      // The recompute boundary: the change (the `===` line) is three lines BELOW
      // the marker line, so a ±1-line window would miss it. An existing H1 above a
      // blank line must stay retained (it is outside the changed block).
      view = mountDoc("# top\n\nfoo\nbar\nbaz\n");
      // Append a "===\n" underline right after "baz\n" (pos 19) → foo/bar/baz H1.
      view.dispatch({ changes: { from: 19, insert: "===\n" } });
      // Confirm the fast (bounded) path actually ran, not the incomplete-frontier
      // full-rebuild fallback — otherwise this would not exercise the bounding.
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      const byLine = fieldClassesByLine(view);
      expect(byLine.get(1)).toBe("quoll-fold-heading-1"); // retained ATX heading
      expect(byLine.get(3)).toBe("quoll-fold-heading-1"); // new Setext title line
      expect(byLine.size).toBe(2);
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });

    it("untags a multi-line Setext title when its underline is deleted", () => {
      view = mountDoc("# top\n\nfoo\nbar\nbaz\n===\n");
      expect(fieldClassesByLine(view).get(3)).toBe("quoll-fold-heading-1");
      // Delete the "===\n" underline → foo/bar/baz reverts to a plain paragraph.
      const und = view.state.doc.toString().indexOf("===");
      view.dispatch({ changes: { from: und, to: und + 4, insert: "" } });
      const byLine = fieldClassesByLine(view);
      expect(byLine.get(1)).toBe("quoll-fold-heading-1"); // ATX heading retained
      expect(byLine.has(3)).toBe(false); // Setext gone
      expect(byLine.size).toBe(1);
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });
  });
});

describe("listFoldGutterLineClass — gutter tag for the list-item vertical-gap offset", () => {
  // Pins the LIST-MARKER-DETECTION contract that drives the gutter `padding-top`
  // offset matching the list line's own `--quoll-list-item-gap` breathing room
  // (PR #13). The PIXEL alignment itself is real-browser-only — happy-dom has no
  // layout — so this asserts ONLY that every list-item marker line (and no other)
  // carries the `quoll-fold-list-marker` gutter tag, in lock-step with the
  // `.cm-line.quoll-list-hang` padding it compensates for.
  function taggedLines(doc: string, extra: readonly unknown[] = []): Map<number, string> {
    view = mountDoc(doc, extra);
    const set = view.state.field(listFoldGutterLineClass);
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

  it("tags each bullet / ordered / task list-item marker line and nothing else", () => {
    // 1 bullet parent, 2 nested bullet child, 3 child continuation (no marker),
    // 5 ordered item, 7 task item, 9 plain paragraph, 11 heading. Blank lines
    // (4/6/8/10) keep each construct unambiguous (no lazy-continuation merges).
    const byLine = taggedLines(
      "- parent\n  - child\n    wrapped\n\n1. ordered\n\n- [ ] task\n\nplain\n\n# heading\n"
    );
    expect(byLine.get(1)).toBe("quoll-fold-list-marker");
    expect(byLine.get(2)).toBe("quoll-fold-list-marker");
    expect(byLine.get(5)).toBe("quoll-fold-list-marker");
    expect(byLine.get(7)).toBe("quoll-fold-list-marker");
    // Continuation line, plain paragraph, and heading are untagged by THIS field.
    expect(byLine.has(3)).toBe(false);
    expect(byLine.has(9)).toBe(false);
    expect(byLine.has(11)).toBe(false);
    expect(byLine.size).toBe(4);
  });

  it("does NOT tag a list-item line inside a quollSyntaxExclusionZones span", () => {
    // A frontmatter YAML list parses as markdown ListItems but gets no
    // `.quoll-list-hang` padding (list-hang-indent.ts skips exclusion zones), so
    // the gutter tag must skip it too or a REVEALED frontmatter list would drop
    // the chevron by the gap. Simulate the frontmatter span with a facet value
    // covering lines 1-2; line 4 (outside the zone) stays tagged.
    const doc = "- inside one\n- inside two\n\n- outside\n";
    const zoneEnd = doc.indexOf("\n\n"); // end of "- inside two"
    const byLine = taggedLines(doc, [quollSyntaxExclusionZones.of([{ from: 0, to: zoneEnd }])]);
    expect(byLine.has(1)).toBe(false);
    expect(byLine.has(2)).toBe(false);
    expect(byLine.get(4)).toBe("quoll-fold-list-marker");
    expect(byLine.size).toBe(1);
  });

  it("does NOT tag an empty list item (resolveListItemHang === null)", () => {
    // An empty `- ` item has no content token, so resolveListItemHang returns
    // null and list-hang-indent.ts emits no padding — the gutter tag must skip it
    // in lock-step. The following non-empty item stays tagged.
    const byLine = taggedLines("-\n- has content\n");
    expect(byLine.has(1)).toBe(false);
    expect(byLine.get(2)).toBe("quoll-fold-list-marker");
    expect(byLine.size).toBe(1);
  });

  it("skips a real frontmatter YAML list via the live frontmatterBlockField facet", () => {
    // Integration guard for the facet WIRING (not just a synthetic zone): mount
    // the real frontmatterBlockField in the SAME extension order as editor.ts
    // (quollFolding BEFORE frontmatterBlockField) so a create-time facet-order
    // regression would surface here. A YAML list inside `---` fences parses as
    // markdown ListItems but sits in the frontmatter exclusion span, so it must
    // NOT be tagged; the body list item below the fence must be.
    view = mountDoc("---\ntags:\n  - alpha\n  - beta\n---\n\n- body item\n", [
      frontmatterBlockField,
    ]);
    const set = view.state.field(listFoldGutterLineClass);
    const tagged = new Set<number>();
    const cursor = set.iter();
    while (cursor.value) {
      tagged.add(view.state.doc.lineAt(cursor.from).number);
      cursor.next();
    }
    // Lines 3-4 are the YAML list inside the frontmatter span → excluded.
    expect(tagged.has(3)).toBe(false);
    expect(tagged.has(4)).toBe(false);
    // Line 7 (`- body item`) is below the fence → tagged.
    expect(tagged.has(7)).toBe(true);
    expect(tagged.size).toBe(1);
  });

  it("recomputes the tag set when the exclusion-zone facet flips with no doc change", () => {
    // Pins the facet-change update trigger (the `startState.facet !== state.facet`
    // clause): a zone contributor that flips on a selection-only transaction (no
    // doc edit, no tree change) must still update the gutter tags. Drive the zone
    // via a StateEffect so the flip carries neither docChanged nor a tree change.
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
    view = mountDoc("- alpha\n- beta\n", [zoneField]);
    const tagged = (): Set<number> => {
      const s = new Set<number>();
      const c = (view as EditorView).state.field(listFoldGutterLineClass).iter();
      while (c.value) {
        s.add((view as EditorView).state.doc.lineAt(c.from).number);
        c.next();
      }
      return s;
    };
    expect(tagged()).toEqual(new Set([1, 2])); // no zones → both tagged
    // Flip a zone over line 1 with NO doc change; the tag set must drop line 1.
    view.dispatch({ effects: setZones.of([{ from: 0, to: view.state.doc.line(1).to }]) });
    expect(tagged()).toEqual(new Set([2]));
  });
});

describe("quollFoldKeymap — the four fold commands are wired into the keymap", () => {
  it("binds foldCode/unfoldCode/foldAll/unfoldAll to their expected key strings", () => {
    // Pin the wiring CONTRACT via the binding TABLE, not runScopeHandlers: happy-dom's
    // platform detection makes single-variant Mod- chord tests flaky (memory
    // quoll-cm-keymap-test-runscopehandlers-platform-flaky). A silent drop of
    // fold-all/unfold-all — the exact regression the task guards against — turns this red.
    const byCommand = new Map(quollFoldKeymap.map((b) => [b.run, b]));
    expect(quollFoldKeymap.length).toBe(4);
    expect(byCommand.get(foldCode)?.key).toBe("Ctrl-Shift-[");
    expect(byCommand.get(foldCode)?.mac).toBe("Cmd-Alt-[");
    expect(byCommand.get(unfoldCode)?.key).toBe("Ctrl-Shift-]");
    expect(byCommand.get(unfoldCode)?.mac).toBe("Cmd-Alt-]");
    expect(byCommand.get(foldAll)?.key).toBe("Ctrl-Alt-[");
    expect(byCommand.get(unfoldAll)?.key).toBe("Ctrl-Alt-]");
    // fold-all / unfold-all are all-platform single-stroke (no mac override — the
    // workbench Ctrl-K chord leader would swallow VS Code's standard fold-all chord).
    expect(byCommand.get(foldAll)?.mac).toBeUndefined();
    expect(byCommand.get(unfoldAll)?.mac).toBeUndefined();
  });

  it("quollFolding() actually mounts the fold keymap (wiring, not just the table)", () => {
    // The binding-table assertion above proves quollFoldKeymap's CONTENTS but not
    // that quollFolding() mounts it — deleting `quollFoldKeymapExtension` from the
    // returned array would leave that test green (Codex finding 1). This closes the
    // gap by reference-equality: the exact keymap extension object must appear in the
    // composed fold extension. `keymap.of(...)` returns a single extension value, so
    // flattening the returned array and checking identity is non-vacuous and avoids
    // synthetic keydown (flaky in happy-dom — memory
    // quoll-cm-keymap-test-runscopehandlers-platform-flaky). Cast to `unknown[]`
    // before `.flat(Infinity)`: CM's `Extension` is a self-recursive type, and
    // `FlatArray<Extension, Infinity>` blows tsc's instantiation-depth limit (TS2589);
    // `unknown` terminates the FlatArray recursion while the runtime flatten is identical.
    const flat = ([quollFolding()] as unknown[]).flat(Number.POSITIVE_INFINITY);
    expect(flat).toContain(quollFoldKeymapExtension);
  });

  it("foldAll folds every heading section and unfoldAll restores it (Quoll ranges, display-only)", async () => {
    // Mount with Quoll's OWN language so foldAll operates over the SAME heading fold
    // ranges production uses (its re-implemented headerIndent foldService + the
    // nonFoldableBlocks subtraction that makes paragraphs/blockquotes/code non-foldable).
    const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
    const doc = "# A\n\ntext a\n\n# B\n\ntext b\n";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [quollMarkdownLanguage(), quollFolding()] }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);

    const before = view.state.doc.toString();
    expect(foldedRanges(view.state).size).toBe(0);

    expect(foldAll(view)).toBe(true);
    // Exactly the two heading sections fold; paragraphs are non-foldable in Quoll's language.
    expect(foldedRanges(view.state).size).toBe(2);
    // Display-only: folding mutates foldState, never the document.
    expect(view.state.doc.toString()).toBe(before);

    expect(unfoldAll(view)).toBe(true);
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.state.doc.toString()).toBe(before);
  });
});
