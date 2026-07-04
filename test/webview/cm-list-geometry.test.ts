import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  resolveListItemHang,
  resolveTaskMarkerGeometry,
} from "../../src/webview/cm/decorations/list-geometry.js";
import { fullTree } from "./helpers/full-tree.js";

function state(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
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

  it("empty item yields null (no content to hang)", () => {
    expect(hangOf("- ", 0)).toBeNull();
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
