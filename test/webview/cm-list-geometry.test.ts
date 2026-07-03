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

  it("plain intermediate carries the ancestor task shift+step (task → plain → plain)", () => {
    // `- [ ] a\n  - b\n    - c`: b is re-based +step under task a; c is plain
    // under plain b so it carries b's shift (incl. the step) WITHOUT a second
    // step (plain parent → source indent shows that level's nesting).
    expect(hangOf("- [ ] a\n  - b\n    - c", 2)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)",
    });
  });

  it("plain-only chain is NOT re-based — no step, tab over-indent preserved", () => {
    expect(hangOf("- outer\n\t- inner", 1)).toEqual({
      indent:
        "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
      pad: "5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)",
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
