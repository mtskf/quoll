import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  resolveContentlessTaskMarkerGeometry,
  resolveListItemHang,
  resolveTaskMarkerGeometry,
} from "../../src/webview/cm/list/list-geometry.js";
import { fullTree } from "./helpers/full-tree.js";

function state(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

/** Resolve the innermost ListItem containing offset `at`. */
function listItemAt(doc: string, at: number) {
  const st = state(doc);
  const tree = fullTree(st);
  let item: ReturnType<typeof tree.resolveInner> | null = null;
  tree.iterate({
    enter: (n) => {
      if (n.name === "ListItem" && n.from <= at && at < n.to) {
        item = n.node;
      }
    },
  });
  return { state: st, item: item! };
}

/** Find the first Task node in `doc` and resolve its marker geometry. */
function taskGeom(doc: string) {
  const st = state(doc);
  const tree = fullTree(st);
  let result: ReturnType<typeof resolveTaskMarkerGeometry> = null;
  tree.iterate({
    enter: (node) => {
      if (node.name === "Task" && result === null) {
        result = resolveTaskMarkerGeometry(st, node.node);
      }
    },
  });
  return result;
}

describe("resolveTaskMarkerGeometry — bullet/ordered fold policy (F7)", () => {
  it("bullet task: foldFrom = ListMark.from (the `- ` folds into the checkbox)", () => {
    expect(taskGeom("- [ ] alpha")).toEqual({
      listMarkFrom: 0,
      taskMarkerFrom: 2,
      taskMarkerTo: 5,
      checked: false,
      isBullet: true,
      foldFrom: 0,
    });
  });

  it("ordered task: foldFrom = TaskMarker.from (the `N. ` stays visible)", () => {
    expect(taskGeom("1. [x] beta")).toEqual({
      listMarkFrom: 0,
      taskMarkerFrom: 3,
      taskMarkerTo: 6,
      checked: true,
      isBullet: false,
      foldFrom: 3,
    });
  });

  it("blockquoted bullet task: still folds (Blockquote grandparent ignored)", () => {
    // `> - [ ] foo`: ListMark `-` at 2, TaskMarker at [4,7).
    expect(taskGeom("> - [ ] foo")).toMatchObject({
      isBullet: true,
      foldFrom: 2,
      taskMarkerFrom: 4,
    });
  });

  it("returns null for a non-Task node (findTaskMarker first-child guard, non-vacuous)", () => {
    // Calls resolveTaskMarkerGeometry on a real Paragraph node so the
    // first-child-not-TaskMarker guard is EXERCISED (the prior `taskGeom`
    // helper never calls the resolver when no Task node exists — vacuous).
    const st = state("- plain item");
    const tree = fullTree(st);
    let result: ReturnType<typeof resolveTaskMarkerGeometry> | "unset" = "unset";
    tree.iterate({
      enter: (n) => {
        if (n.name === "Paragraph" && result === "unset") {
          result = resolveTaskMarkerGeometry(st, n.node);
        }
      },
    });
    expect(result).toBeNull();
  });
  // NOTE: the 3-byte length + `[ ]`/`[x]`/`[X]` slice guards inside
  // findTaskMarker are defensive against a stale / one-update-behind Lezer tree
  // (a `Task` whose marker is mid-mutation). @lezer/markdown never emits a
  // `Task` with a malformed marker from a FRESH parse, so those branches are
  // unreachable-by-construction in a unit test — same precedent as the existing
  // findTaskMarker comment. The F7 fail-closed symmetry (Task 1's ownMarkerWidth
  // returns null for a Task whose geometry is null, mirroring reveal emitting no
  // checkbox) is enforced structurally, not by a parse-based test.
});

describe("resolveContentlessTaskMarkerGeometry", () => {
  it("resolves a content-less bullet checkbox `- [ ]` (no Task node exists)", () => {
    const { state, item } = listItemAt("- [ ]", 0);
    expect(resolveContentlessTaskMarkerGeometry(state, item)).toEqual({
      listMarkFrom: 0,
      taskMarkerFrom: 2,
      taskMarkerTo: 5,
      checked: false,
      isBullet: true,
      foldFrom: 0,
    });
  });

  it("resolves a checked content-less `- [x]`", () => {
    const { state, item } = listItemAt("- [x]", 0);
    expect(resolveContentlessTaskMarkerGeometry(state, item)?.checked).toBe(true);
  });

  it("returns null for a real content-bearing task `- [ ] a`", () => {
    const { state, item } = listItemAt("- [ ] a", 0);
    expect(resolveContentlessTaskMarkerGeometry(state, item)).toBeNull();
  });

  it("returns null for a plain empty bullet `-`", () => {
    const { state, item } = listItemAt("-", 0);
    expect(resolveContentlessTaskMarkerGeometry(state, item)).toBeNull();
  });

  // Continuation-body task (`- [ ]\n  child`) renders literal, NOT a checkbox:
  // the marker + indented body parse as one multi-byte Paragraph (no Task node),
  // matching GitHub's cmark-gfm (same-line space required). See the render
  // decision documented in task-marker-shape.ts. Widening the predicate to
  // accept a first-content Paragraph starting with `[ ]` would break these.
  it("returns null for a continuation-body task `- [ ]\\n  child` (literal, matches GitHub)", () => {
    const { state, item } = listItemAt("- [ ]\n  child", 0);
    expect(resolveContentlessTaskMarkerGeometry(state, item)).toBeNull();
  });

  it("returns null for a checked continuation-body task `- [x]\\n  done body`", () => {
    const { state, item } = listItemAt("- [x]\n  done body", 0);
    expect(resolveContentlessTaskMarkerGeometry(state, item)).toBeNull();
  });

  it("ordered content-less `1. [ ]` keeps foldFrom at the marker (number stays visible)", () => {
    const { state, item } = listItemAt("1. [ ]", 0);
    const g = resolveContentlessTaskMarkerGeometry(state, item);
    expect(g?.isBullet).toBe(false);
    expect(g?.foldFrom).toBe(g?.taskMarkerFrom);
  });
});

/** Resolve the hang for the Nth (0-based) ListItem in document order. */
function hangOf(doc: string, index: number) {
  const st = state(doc);
  const tree = fullTree(st);
  const items: Array<ReturnType<typeof resolveListItemHang>> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === "ListItem") {
        items.push(resolveListItemHang(st, node.node));
      }
    },
  });
  return items[index];
}

/** Hang of the FIRST (top-level) ListItem in `doc`. */
function hangOfTop(doc: string) {
  return hangOf(doc, 0);
}

/** Hang of the innermost nested-child ListItem — the LAST ListItem in document
 *  order (all fixtures here have a single nested child on the final line). */
function hangOfNestedChild(doc: string) {
  const st = state(doc);
  const tree = fullTree(st);
  const items: Array<ReturnType<typeof resolveListItemHang>> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === "ListItem") {
        items.push(resolveListItemHang(st, node.node));
      }
    },
  });
  return items[items.length - 1];
}

/** Renderability of the innermost nested-child ListItem (LAST in doc order). */
function isRenderableOfNestedChild(doc: string) {
  const st = state(doc);
  const tree = fullTree(st);
  const flags: boolean[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === "ListItem") {
        flags.push(resolveListItemHang(st, node.node) !== null);
      }
    },
  });
  return flags[flags.length - 1];
}

describe("resolveListItemHang — recursive geometry (F1 + NEST_STEP)", () => {
  it("task child under a task parent: one checkbox shift + one outline step", () => {
    // `- [ ] a\n  - [ ] b`: b's checkbox renders one NEST_STEP (2ch) past a's
    // content column (markers:2 = a's checkbox col + b's own checkbox; ch:2 = step).
    expect(hangOf("- [ ] a\n  - [ ] b", 1)).toEqual({
      indent: "2 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)",
      pad: "2 * var(--quoll-prose-space, 1ch) + 2 * var(--quoll-task-marker-width)",
    });
  });

  it("three levels (task → task → plain): TWO checkbox shifts + TWO outline steps", () => {
    // step accrues once per task-fold level: 2 levels → +4ch (2ch in the 6ch
    // ch-term is c's own marker, 4ch is the two steps).
    expect(hangOf("- [ ] a\n  - [ ] b\n    - c", 2)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + 2 * var(--quoll-task-marker-width)",
    });
  });

  it("plain intermediate under a task parent, plus its own bullet-nest step (task → plain → plain)", () => {
    // `- [ ] a\n  - b\n    - c`: b re-bases +NEST_STEP under task a; c is a bullet
    // under the plain-bullet b, so it ALSO gains one BULLET_NEST_STEP (+2 cols).
    // indent (source-relative first-line pull) is unchanged; only pad steps out.
    expect(hangOf("- [ ] a\n  - b\n    - c", 2)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "7 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
    });
  });

  it("bullet nested under a plain bullet gains one step in pad (tab over-indent preserved)", () => {
    // `- outer\n\t- inner`: inner is a bullet under the plain-bullet outer, so pad
    // steps +2 cols (5→7). indent stays source-relative (5). The tab over-indent
    // residual is orthogonal and preserved.
    expect(hangOf("- outer\n\t- inner", 1)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "7 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("empty item hangs like a canonical `- item` (implied single-space indent)", () => {
    // Was `.toBeNull()` before content-less/empty items were made renderable.
    expect(hangOf("- ", 0)).toEqual(hangOf("- item", 0));
  });

  it("plain bullet splits its `-` glyph column from the trailing space", () => {
    // `- item`: 1 glyph col (the `-`) + 1 space col → the glyph col is sized in
    // the GLYPH blend so the wrapped line hangs under the text, not left of it.
    expect(hangOf("- item", 0)).toEqual({
      indent:
        "1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("ordered `10.` counts three glyph columns (`1`,`0`,`.`)", () => {
    expect(hangOf("10. item", 0)).toEqual({
      indent:
        "1 * var(--quoll-prose-space, 1ch) + 3 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "1 * var(--quoll-prose-space, 1ch) + 3 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("ordered `)` form (`1) item`) splits the same as `.` (ListMark span)", () => {
    // Guards Lezer's `)`-delimited ordered ListMark: `1)` is 2 glyph cols.
    expect(hangOf("1) item", 0)).toEqual({
      indent:
        "1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("ordered TASK (`1. [x]`) splits the visible `N.` glyph run from its space + checkbox", () => {
    // `1. [x] foo`: the `1.` is 2 glyph cols (GLYPH blend, like plain ordered),
    // 1 trailing prose-space col up to the folded checkbox, + the checkbox
    // token. The all-prose-space form under-hung the wrapped continuation
    // (browser-harness ~-2.3px for `1.`, worse multi-digit) — this pins the fix.
    expect(hangOf("1. [x] foo", 0)).toEqual({
      indent:
        "1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
      pad: "1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
    });
  });

  it("multi-digit ordered TASK (`10. [ ]`) counts three glyph columns (`1`,`0`,`.`)", () => {
    expect(hangOf("10. [ ] foo", 0)).toEqual({
      indent:
        "1 * var(--quoll-prose-space, 1ch) + 3 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
      pad: "1 * var(--quoll-prose-space, 1ch) + 3 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
    });
  });

  it("ordered `)` TASK (`1) [x]`) splits the same as `.` — Lezer delimiter guard", () => {
    // Mirrors the plain `1) item` guard: pins that a `)`-delimited item is an
    // OrderedList (isBullet=false, keeps `1)` visible) — not a BulletList — so
    // the glyph split runs and matches `1. [x]` (the delimiter doesn't change
    // the 2 glyph cols / 1 space / checkbox counts).
    expect(hangOf("1) [x] foo", 0)).toEqual({
      indent:
        "1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
      pad: "1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
    });
  });

  it("bullet TASK (`- [x]`) stays glyph:0 — the `- ` folds into the checkbox (regression guard)", () => {
    // The glyph split is CLAMPED to foldFrom: for a bullet task foldFrom ==
    // listMarkFrom, so glyph and ch are both 0 — byte-identical with the
    // pre-split all-prose-space form. Guards against the split perturbing the
    // invariant-sensitive bullet-task fold.
    expect(hangOf("- [x] foo", 0)).toEqual({
      indent: "0 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)",
      pad: "0 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)",
    });
  });

  it("mixed nested siblings align: plain `- b` and task `- [ ] c` share a marker column", () => {
    // `- a\n  - b\n  - [ ] c`: the step keys on the plain-bullet PARENT a, so BOTH
    // siblings step (+2). Their marker columns are equal (renderedMarkCol {ch:4})
    // — pad − indent is 2 cols for each: b (5−3) and c (4−2). A child-keyed gate
    // would leave c unstepped (pad "2 * … + MARKER") and misalign them ~7px.
    expect(hangOf("- a\n  - b\n  - [ ] c", 1)).toEqual({
      indent:
        "3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
    expect(hangOf("- a\n  - b\n  - [ ] c", 2)).toEqual({
      indent: "2 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)",
      pad: "4 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)",
    });
  });

  it("bullet double-nest steps +2 pad cols per level (`- a` → `  - b` → `    - c`)", () => {
    // Per-level pad step is 4 cols (2 literal source cols + 2 BULLET_NEST_STEP):
    // L2 pad 5, L3 pad 9. indent stays source-relative (3 / 5).
    expect(hangOf("- a\n  - b\n    - c", 1)).toEqual({
      indent:
        "3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
    expect(hangOf("- a\n  - b\n    - c", 2)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "9 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("ordered child under a bullet chain carries the bullet step but does NOT double-step it", () => {
    // `- a\n  - b\n    1. c`: c is an OrderedList item → the gate's child check
    // fails, so no OWN step; but it CARRIES b's +2 via the shift (pad − indent =
    // 2 cols). Guards that the carry works AND an ordered child is not stepped.
    expect(hangOf("- a\n  - b\n    1. c", 2)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "7 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("blockquote-nested bullet does NOT gain the step (Blockquote-ancestor exclusion)", () => {
    // `> - outer\n>   - inner` (raw, hiddenPrefixCols=0): inner nests in outer but
    // is inside a Blockquote → no step, pad stays source-relative (5), unchanged.
    expect(hangOf("> - outer\n>   - inner", 1)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("ordered child under a plain bullet does NOT gain the step (child not a bullet)", () => {
    // `- a\n  1. b`: child is an OrderedList item → gate fails, ordered geometry
    // unchanged (source-relative).
    expect(hangOf("- a\n  1. b", 1)).toEqual({
      indent:
        "3 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "3 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });

  it("bullet under an ordered parent does NOT gain the step (parent not a bullet)", () => {
    // `1. a\n   - b`: parent is an OrderedList item → gate fails, the bullet
    // sublist under an ordered item keeps its source-relative hang.
    expect(hangOf("1. a\n   - b", 1)).toEqual({
      indent:
        "4 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "4 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });
});

describe("content-less / empty items — hang", () => {
  // (b) empty nested bullet aligns with a content-bearing sibling at the same
  // source indent: with the CommonMark implied single-space indent, the empty
  // item's hang is byte-IDENTICAL to a canonical `  - x` sibling.
  it("empty nested bullet `  -` hangs identically to `  - x`", () => {
    expect(hangOfNestedChild("- parent\n  -")).toEqual(hangOfNestedChild("- parent\n  - x"));
  });

  // Non-vacuity: before the fix the empty child had NO hang (null).
  it("empty nested bullet is renderable (was null before fix)", () => {
    expect(isRenderableOfNestedChild("- parent\n  -")).toBe(true);
  });

  // (a-hang) a content-less checkbox hangs as a TASK (markers:1 → MARKER token),
  // identical to a content-bearing checkbox — NOT as a plain `-` bullet.
  it("content-less `- [ ]` hangs identically to `- [ ] a`", () => {
    expect(hangOfTop("- [ ]")).toEqual(hangOfTop("- [ ] a"));
    expect(hangOfTop("- [ ]")?.pad).toContain("var(--quoll-task-marker-width)");
  });

  // (Codex #5) a content-less task PARENT re-bases its child past the checkbox,
  // identically to a content-bearing task parent.
  it("child under a content-less task parent hangs like child under a content task parent", () => {
    expect(hangOfNestedChild("- [ ]\n  - child")).toEqual(hangOfNestedChild("- [ ] a\n  - child"));
  });

  it("empty top-level bullet `-` still starts at the base column (indent === pad)", () => {
    const h = hangOfTop("-");
    expect(h?.indent).toEqual(h?.pad);
  });
});

describe("resolveListItemHang — hiddenPrefixCols subtracts the blockquote prefix", () => {
  it("`> - item` with prefixCols 2 reduces to the plain `- item` hang", () => {
    const st = state("> - item");
    const tree = fullTree(st);
    let hang: ReturnType<typeof resolveListItemHang> = null;
    tree.iterate({
      enter: (n) => {
        if (n.name === "ListItem" && hang === null) {
          hang = resolveListItemHang(st, n.node, 2);
        }
      },
    });
    expect(hang).toEqual({
      indent:
        "1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
    });
  });
});
