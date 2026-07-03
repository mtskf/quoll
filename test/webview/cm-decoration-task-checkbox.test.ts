import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  findTaskMarker,
  taskCheckboxReveal,
} from "../../src/webview/cm/decorations/task-checkbox-reveal.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { fullTree } from "./helpers/full-tree.js";

function ctx(doc: string, caret: number): BuildContext {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
    selection: EditorSelection.single(caret),
  });
  return {
    state,
    selection: state.selection,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

// Widget-replace ranges only (spec.widget present). The content-mute marks
// Task 3 adds carry a `class` and no `widget`; contentMarkRanges() below
// collects those separately so each contract is pinned in isolation.
function ranges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    if ((iter.value.spec as { widget?: unknown }).widget) {
      out.push({ from: iter.from, to: iter.to });
    }
    iter.next();
  }
  return out;
}

// Content-mute mark ranges (the checked-task recede). Filters to the class the
// reveal emits so a stray widget range can never masquerade as a content mark.
function contentMarkRanges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    if ((iter.value.spec as { class?: string }).class === "quoll-task-completed-content") {
      out.push({ from: iter.from, to: iter.to });
    }
    iter.next();
  }
  return out;
}

describe("taskCheckboxReveal — provider", () => {
  it("emits one replace per Task when caret is OFF the task lines (range widened to swallow the `-` bullet)", () => {
    // doc: `- [ ] alpha\n- [x] beta\n\nparagraph`
    // Widened replace ranges (ListMark.from → TaskMarker.to):
    //   - line 1: [0, 5)   (`- [ ]`)
    //   - line 2: [12, 17) (`- [x]`)
    const doc = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3; // inside trailing paragraph
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([
      { from: 0, to: 5 },
      { from: 12, to: 17 },
    ]);
  });

  it("emits nothing for the task whose LINE the caret intersects (reveal-trigger = line)", () => {
    // Caret on line 1 → line-1 task source visible (no decoration); line-2 task still hidden.
    const doc = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const caret = 0; // start of line 1
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([{ from: 12, to: 17 }]);
  });

  it("intersection is line-wide: caret at end of task body still reveals the task line", () => {
    // Caret right after "alpha" (still on line 1) — line-1 source must be visible.
    const doc = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const caret = doc.indexOf("alpha") + 5;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([{ from: 12, to: 17 }]);
  });

  it("multi-cursor: each task line with a caret reveals independently (cross product) — allowMultipleSelections facet ON", () => {
    const doc = "- [ ] alpha\n- [x] beta\n- [ ] gamma";
    const state = EditorState.create({
      doc,
      // CodeMirror collapses multi-range selections to the main range unless
      // this facet is ON. Without it the second caret silently disappears and
      // the cross-product reveal logic is never exercised.
      extensions: [
        markdown({ base: markdownLanguage }),
        EditorState.allowMultipleSelections.of(true),
      ],
      selection: EditorSelection.create(
        [EditorSelection.cursor(0), EditorSelection.cursor(doc.indexOf("gamma"))],
        0
      ),
    });
    const set = taskCheckboxReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: state.doc.length }],
      tree: fullTree(state),
    });
    // Carets on line 1 + line 3 → only line 2's marker is hidden.
    expect(ranges(set)).toEqual([{ from: 12, to: 17 }]);
  });

  it("emits nothing for non-task list items (plain `- foo`)", () => {
    const doc = "- alpha\n- beta\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([]);
  });

  it("respects ctx.visibleRanges (drops tasks outside the window)", () => {
    const doc = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
      selection: EditorSelection.single(doc.indexOf("paragraph") + 3),
    });
    const set = taskCheckboxReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: 11 }], // line-1 only
      tree: fullTree(state),
    });
    expect(ranges(set)).toEqual([{ from: 0, to: 5 }]);
  });

  it("findTaskMarker returns the marker range + checked state when the Task's first child IS a TaskMarker with a valid 3-byte slice", () => {
    // The helper concentrates the Lezer name + slice validation in one
    // place so a future grammar rename surfaces in exactly one spot.
    // Pin all three states: ` `, `x`, `X`. `findTaskMarker` is imported
    // at the top of this file (require() is undefined in Vitest's ESM
    // runtime).
    const doc = "- [ ] alpha\n- [x] beta\n- [X] gamma";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
    const tree = fullTree(state);
    const tasks: Array<{ from: number; to: number; checked: boolean } | null> = [];
    tree.iterate({
      enter: (node) => {
        if (node.name === "Task") {
          tasks.push(findTaskMarker(state, node.node));
        }
      },
    });
    expect(tasks).toEqual([
      { from: 2, to: 5, checked: false },
      { from: 14, to: 17, checked: true },
      { from: 25, to: 28, checked: true },
    ]);
  });

  it("nested task lists: every Task node gets its own widget independently (indent preserved by widening only to ListMark.from, not line start)", () => {
    // Nested list: outer task contains a nested task on indented line.
    const doc = "- [ ] outer\n  - [x] inner\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    // outer: ListMark "-" at [0,1), TaskMarker "[ ]" at [2,5) → widened [0, 5)
    // inner:
    //   line 1 "- [ ] outer\n" = 12 bytes (incl. \n)
    //   line 2 "  - [x] inner" → ListMark "-" at 14, TaskMarker "[x]" at [16,19)
    //   widened range is [14, 19) — the 2 leading spaces survive (they live
    //   in [12, 14) and are NOT part of the replace).
    expect(ranges(set)).toEqual([
      { from: 0, to: 5 },
      { from: 14, to: 19 },
    ]);
  });

  it("nested task lists, TAB-indented inner (`\\t- [x] inner`): widened range tracks ListMark.from, the literal tab byte survives", () => {
    // C5b follow-up coverage pin. The existing nested case above uses a
    // 2-space indent (ListMark.from = 14 → widened [14, 19)). A single
    // leading TAB is one byte, not two, so the same logical nesting lands
    // the inner ListMark one byte earlier — pinning that the widened range
    // [ListMark.from, TaskMarker.to) is derived from the raw byte the
    // parser saw, NOT a column count. Byte offsets verified against the
    // live `@lezer/markdown` tree (not computed by hand):
    //   line 1 "- [ ] outer\n" = 12 bytes incl. `\n` → [0, 12)
    //   line 2 "\t- [x] inner": tab at [12, 13), ListMark "-" at [13, 14),
    //     TaskMarker "[x]" at [15, 18) → widened [13, 18). The leading tab
    //     lives in [12, 13) and is NOT part of the replace, so it stays.
    // Non-vacuous: widening to `line.from` instead of `ListMark.from` would
    // emit [12, 18) (swallowing the tab); an indent-normaliser that rewrote
    // `\t` → spaces before parse would shift ListMark.from and break this.
    const doc = "- [ ] outer\n\t- [x] inner\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([
      { from: 0, to: 5 },
      { from: 13, to: 18 },
    ]);
  });

  it("widens the replace range to swallow `*` and `+` bullet markers (same column treatment as `-`)", () => {
    const doc = "* [ ] star\n+ [x] plus\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    // line 1 "* [ ] star\n" → ListMark at 0, TaskMarker.to = 5 → widened [0, 5)
    // line 2 "+ [x] plus"   → ListMark at 11, TaskMarker.to = 16 → widened [11, 16)
    expect(ranges(set)).toEqual([
      { from: 0, to: 5 },
      { from: 11, to: 16 },
    ]);
  });

  it("widens the replace range for blockquote-wrapped bullet tasks `> - [ ] foo` (Blockquote grandparent is not inspected — bullet folds anyway)", () => {
    // Coverage pin for the C5b blockquote gap (PR #118 /review-cycle).
    // Lezer GFM emits `Blockquote → BulletList → ListItem → Task` for a
    // blockquoted task item. `findBulletListMarkStart` walks
    // `task.parent` (ListItem) → `listItem.parent` and only checks
    // `list.name === "BulletList"`; the `Blockquote` grandparent is never
    // inspected, so the widening fires for blockquoted bullet tasks too —
    // correct (the bullet is bullet-shaped regardless of the wrap), but
    // previously unpinned. This catches a future refactor that climbs one
    // more `.parent` level and accidentally requires a non-Blockquote
    // grandparent. Verified non-vacuous: re-adding a Blockquote-grandparent
    // reject to `findBulletListMarkStart` drops this to `[{ from: 4, to: 7 }]`.
    const doc = "> - [ ] foo\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    // `> - [ ] foo`: `>` at 0, ` ` at 1, ListMark "-" at [2,3),
    // TaskMarker "[ ]" at [4,7) → widened [2, 7) (swallows the bullet,
    // the blockquote `> ` prefix at [0,2) stays visible).
    expect(ranges(set)).toEqual([{ from: 2, to: 7 }]);
  });

  it("widens decoration at the iterate window boundary (window [0, 2), Task at [2, 11) — Lezer's touch semantics enters the Task)", () => {
    // Boundary pin (Codex cycle 2 #1, Conf 93). Lezer's `tree.iterate`
    // uses touch semantics (`node.from <= to && node.to >= from`), so
    // Task[2, 11) IS entered when iterating over window [0, 2). In that
    // case the ListMark at [0, 1) is inside the window but TaskMarker
    // [2, 5) sits exactly on the closing edge. The overlap guard must
    // use `replaceFrom (0) < range.to (2)` → true → emit. If the guard
    // used `marker.from (2) < range.to (2)` → false → silent drop of a
    // decoration whose bullet IS visible. Verified empirically against
    // `@lezer/common@1.5.2`.
    // Doc has a 2nd line so the caret can sit OFF the task line — otherwise
    // intersectsAnySelection would suppress the decoration regardless of
    // the iterate-window behaviour we're trying to pin.
    const doc = "- [ ] alpha\n\nparagraph";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
      selection: EditorSelection.single(doc.indexOf("paragraph") + 3),
    });
    const set = taskCheckboxReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: 2 }], // ListMark visible, TaskMarker at boundary
      tree: fullTree(state),
    });
    expect(ranges(set)).toEqual([{ from: 0, to: 5 }]);
  });

  it("widget receives `marker.from` (= TaskMarker.from), NOT the widened `replaceFrom`, so toggleTaskCheckbox dispatches at the correct byte for bullet tasks", () => {
    // Producer-side pin for the C5b load-bearing claim: the widget's
    // stored `from` MUST equal TaskMarker.from (not ListMark.from). The
    // widget passes `this.from` to toggleTaskCheckbox which dispatches
    // at `markerFrom + 1`; for bullet tasks, passing the widened
    // `replaceFrom` would aim at byte 1 (the space after `-`) and the
    // Lezer cross-check in task-checkbox-command.ts would silently abort
    // toggles on bullet-list tasks. (Ordered-list tasks and any case
    // where `replaceFrom === marker.from` are unaffected — they share
    // the same byte.)
    const doc = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    const widgetFroms: number[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { widget?: { from?: number } };
      if (spec.widget && typeof spec.widget.from === "number") {
        widgetFroms.push(spec.widget.from);
      }
      iter.next();
    }
    expect(widgetFroms).toEqual([2, 14]); // TaskMarker.from, NOT 0 / 12
  });

  it("leaves ordered-list tasks `1. [ ] …` with the number visible (replace covers only the TaskMarker)", () => {
    // Regression pin (forward-looking). This test is vacuous against
    // the pre-C5b code (which always used `marker.from`, so [3, 6) /
    // [18, 21) also pass there) — its value is catching FUTURE changes,
    // not pinning a present-day behavioural change. Specifically, if
    // `findBulletListMarkStart` ever stops checking
    // `list.name === "BulletList"` (e.g. someone widens it to "any
    // list type"), this test catches it — the widened range would
    // become [0, 6) / [15, 21) and swallow `1. ` / `2. `, which the
    // plan contract explicitly forbids ("keep numbering visible so
    // users can edit it").
    const doc = "1. [ ] ordered\n2. [x] second\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    // line 1: ListMark "1." at [0,2), TaskMarker "[ ]" at [3,6) → stays [3, 6)
    // line 2: ListMark "2." starts at 15, TaskMarker "[x]" at [18,21) → stays [18, 21)
    expect(ranges(set)).toEqual([
      { from: 3, to: 6 },
      { from: 18, to: 21 },
    ]);
  });

  it("emits a content-mute mark over a CHECKED task's content span when the caret is off the line", () => {
    // `- [ ] alpha\n- [x] beta\n\nparagraph`: line 2 `- [x] beta` → TaskMarker.to = 17,
    // line.to = 22 (the `\n` sits AT 22, NOT included), so the completed content span
    // is [17, 22) = " beta". The unchecked line 1 gets none.
    const doc = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(contentMarkRanges(set)).toEqual([{ from: 17, to: 22 }]);
  });

  it("emits NO content-mute mark for an UNCHECKED task", () => {
    const doc = "- [ ] alpha\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(contentMarkRanges(set)).toEqual([]);
  });

  it("suppresses the content-mute mark when the caret is ON the completed line (rides the widget reveal-trigger)", () => {
    // Caret on line 2 (the `- [x] beta` line) → both the widget AND the content mute drop,
    // exposing raw `[x] beta` at full strength for editing.
    const doc = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const caret = doc.indexOf("beta"); // inside line 2
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    expect(contentMarkRanges(set)).toEqual([]);
  });

  it("the content-mute mark carries the quoll-task-completed-content class (pins the class contract, not pixels)", () => {
    const doc = "- [x] done item\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = taskCheckboxReveal.build(ctx(doc, caret));
    const classes: string[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      const cls = (iter.value.spec as { class?: string }).class;
      if (cls) {
        classes.push(cls);
      }
      iter.next();
    }
    expect(classes).toContain("quoll-task-completed-content");
  });
});
