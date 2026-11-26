// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Parser as CmarkParser } from "commonmark";
import { describe, expect, it } from "vitest";
import {
  classifyItemLines,
  contentColumnOf,
  continuationMarkerFor,
  formatMarker,
  isEmptyItem,
  parseListMark,
  planIndentItem,
  planOutdentItem,
  renumberRun,
} from "../../../src/webview/cm/list/list-transform.js";
import { settledMount } from "../helpers/settled-view.js";

function mount(
  doc: string,
  selection: EditorSelection | SelectionRange,
  opts: { readOnly?: boolean } = {}
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.readOnly.of(opts.readOnly ?? false),
    ],
  });
  return settledMount({ state, parent });
}

// Resolves the `ListItem` enclosing line `n`'s first non-whitespace column,
// walking up from the syntax tree's innermost node — same probe strategy as
// list-tree.ts's listItemAt, duplicated here (test-only) to avoid coupling
// this classifier test to the caret-resolution module.
function resolveItemAtLine(
  state: EditorState,
  n: number
): ReturnType<typeof syntaxTree>["topNode"] {
  const line = state.doc.line(n);
  const wsLen = line.text.length - line.text.trimStart().length;
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(
    line.from + wsLen,
    1
  );
  while (node !== null) {
    if (node.name === "ListItem") {
      return node;
    }
    node = node.parent;
  }
  throw new Error(`no ListItem found at line ${n}`);
}

describe("parseListMark", () => {
  it("classifies bullet glyphs", () => {
    expect(parseListMark("-")).toEqual({ kind: "bullet", glyph: "-" });
    expect(parseListMark("*")).toEqual({ kind: "bullet", glyph: "*" });
    expect(parseListMark("+")).toEqual({ kind: "bullet", glyph: "+" });
  });
  it("classifies ordered markers, multi-digit, both delimiters", () => {
    expect(parseListMark("1.")).toEqual({ kind: "ordered", number: 1, delim: "." });
    expect(parseListMark("10)")).toEqual({ kind: "ordered", number: 10, delim: ")" });
    expect(parseListMark("999999999.")).toEqual({ kind: "ordered", number: 999999999, delim: "." });
  });
  it("rejects a 10+-digit run (Lezer does not treat it as a ListMark)", () => {
    expect(parseListMark("1234567890.")).toBeNull();
  });
  it("returns null on non-marker text", () => {
    expect(parseListMark("x")).toBeNull();
  });
});

describe("formatMarker", () => {
  it("round-trips (zero-pad width not preserved — plain decimal)", () => {
    expect(formatMarker({ kind: "bullet", glyph: "*" })).toBe("*");
    expect(formatMarker({ kind: "ordered", number: 3, delim: ")" })).toBe("3)");
  });
});

describe("renumberRun", () => {
  it("re-indents a widened sibling's nested child (9. -> 10.)", () => {
    const view = mount("8. a\n9. b\n   - child\n", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1); // "8. a"
      // Renumber followers of "8. a" from 10: "9. b" -> "10. b" (width 1->2),
      // so its child "   - child" gains one leading space -> "    - child".
      view.dispatch({ changes: renumberRun(view.state, a, 10) });
      expect(view.state.doc.toString()).toBe("8. a\n10. b\n    - child\n");
    } finally {
      view.destroy();
    }
  });

  // `body` sits after a blank line, so it is a paragraph of the parent list, not
  // of the bare `9.`. Widening `9.` must not shift it: a fourth space would turn
  // it into indented code.
  it("leaves a paragraph after a bare marker's blank line alone (9. -> 10.)", () => {
    const view = mount("8. first\n9.\n\n   body", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      view.dispatch({ changes: renumberRun(view.state, a, 10) });
      expect(view.state.doc.toString()).toBe("8. first\n10.\n\n   body");
    } finally {
      view.destroy();
    }
  });

  // A blank line between two body paragraphs does not end the item, so widening
  // `9. ` shifts both. Needs the patched @lezer/markdown 1.8.1.
  it("shifts every paragraph of a multi-paragraph body (9. -> 10.)", () => {
    const view = mount("8. prev\n9. \n   first\n\n   second", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      view.dispatch({ changes: renumberRun(view.state, a, 10) });
      expect(view.state.doc.toString()).toBe("8. prev\n10. \n    first\n\n    second");
    } finally {
      view.destroy();
    }
  });

  it("preserves the run's `)` delimiter while renumbering", () => {
    // CommonMark requires a uniform delimiter within one OrderedList (a mixed
    // delimiter starts a NEW list, so a genuine Lezer-sibling run always shares
    // one delimiter) — this pins that renumberRun reads each sibling's OWN
    // delimiter from its marker rather than hard-coding "." .
    const view = mount("1) a\n2) b\n3) c", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      view.dispatch({ changes: renumberRun(view.state, a, 5) });
      expect(view.state.doc.toString()).toBe("1) a\n5) b\n6) c");
    } finally {
      view.destroy();
    }
  });

  it("does not touch a following sibling's own width when width is unchanged", () => {
    const view = mount("1. a\n2. b\nlazy line\n3. c", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      view.dispatch({ changes: renumberRun(view.state, a, 2) });
      expect(view.state.doc.toString()).toBe("1. a\n2. b\nlazy line\n3. c");
    } finally {
      view.destroy();
    }
  });

  it("de-indents a NARROWED sibling's nested child (10. -> 9., width shrink)", () => {
    // The width-SHRINK branch: renumbering "10. b" down to "9. b" (2->1 byte)
    // shifts its content column left by one, so its nested "    - child"
    // (col 4) must lose a leading space -> "   - child" (col 3). This exercises
    // the negative-deltaWidth removal path, which the WIDEN test above cannot.
    const view = mount("9. a\n10. b\n    - child", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1); // "9. a"
      // Renumber followers of "9. a" from 9: "10. b" -> "9. b".
      view.dispatch({ changes: renumberRun(view.state, a, 9) });
      expect(view.state.doc.toString()).toBe("9. a\n9. b\n   - child");
    } finally {
      view.destroy();
    }
  });

  it("fails closed (returns []) when a new number would exceed 9 digits", () => {
    const view = mount("1. a\n2. b\n", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      const changes = renumberRun(view.state, a, 1_000_000_000);
      expect(changes).toEqual([]);
    } finally {
      view.destroy();
    }
  });
});

describe("continuationMarkerFor", () => {
  it("builds a bullet marker", () => {
    const view = mount("- a", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(continuationMarkerFor(view.state, item)).toBe("- ");
    } finally {
      view.destroy();
    }
  });

  it("builds an incremented ordered marker, preserving the delimiter", () => {
    const view = mount("1) a", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(continuationMarkerFor(view.state, item)).toBe("2) ");
    } finally {
      view.destroy();
    }
  });

  it("appends an always-unchecked task marker for a task predecessor", () => {
    const view = mount("- [x] done", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(continuationMarkerFor(view.state, item)).toBe("- [ ] ");
    } finally {
      view.destroy();
    }
  });
});

describe("isEmptyItem", () => {
  it("is true for a bare bullet marker", () => {
    const view = mount("- ", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("is true for a content-less `[ ]` task Paragraph", () => {
    const view = mount("- [ ]", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("is true for a whitespace-only Task", () => {
    const view = mount("- [ ] ", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("is false for a non-empty item", () => {
    const view = mount("- a", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  // A bare marker line whose item owns later lines is NOT empty: both consumers'
  // empty arms (Enter deletes the marker line, outdent skips the body shift)
  // would destroy that body. The `> ` case puts a QuoteMark, not the body, right
  // after the ListMark.
  it.each([
    "-\n  text",
    "-\n  - child",
    "> -\n>   text",
  ])("is false when the item owns a continuation body (%j)", (doc) => {
    const view = mount(doc, EditorSelection.cursor(0));
    try {
      // The marker `-` is the first ListMark in every doc; walk up to its item.
      const mark = syntaxTree(view.state).resolveInner(doc.indexOf("-"), 1);
      const item = mark.parent;
      expect(mark.name).toBe("ListMark");
      expect(item?.name).toBe("ListItem");
      expect(isEmptyItem(view.state, item as NonNullable<typeof item>)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  // The true side: a bare marker line that owns nothing below, including inside
  // a blockquote, mid-list, and before a blank line (`-\n\n  text` — an item may
  // start with at most one blank line, so `text` is not its body, even though
  // Lezer's item span covers it).
  it.each([
    ["> -", 1],
    ["> - a\n> -", 2],
    ["- a\n-\n- b", 2],
    ["-\n\n  text", 1],
  ] as const)("is true for a bare marker line that owns nothing below (%j line %i)", (doc, lineNo) => {
    const view = mount(doc, EditorSelection.cursor(0));
    try {
      const line = view.state.doc.line(lineNo);
      const mark = syntaxTree(view.state).resolveInner(line.from + line.text.indexOf("-"), 1);
      const item = mark.parent;
      expect(mark.name).toBe("ListMark");
      expect(item?.name).toBe("ListItem");
      expect(isEmptyItem(view.state, item as NonNullable<typeof item>)).toBe(true);
    } finally {
      view.destroy();
    }
  });
});

describe("contentColumnOf — empty marker line", () => {
  // `> -\n>   - child`: the marker line has no content node, and nextSibling is
  // the continuation line's QuoteMark at col 0. The content column must come
  // from the marker line (markCol 2 + 1 + 1), not from that other line.
  it("uses the implied single-space column, not a later line's node", () => {
    const view = mount("> -\n>   - child\n", EditorSelection.cursor(0));
    try {
      // Probe at the `-` (offset 2): line 1's first non-ws char is the `>`.
      const item = syntaxTree(view.state).resolveInner(2, 1).parent;
      expect(item?.name).toBe("ListItem");
      expect(contentColumnOf(view.state, item!)).toBe(4);
    } finally {
      view.destroy();
    }
  });
});

describe("classifyItemLines", () => {
  it("classifyItemLines splits marker vs own body and drops the lazy tail", () => {
    // Broken 2-space doc: "- ddd" swallows "3. ddd\n4. ddd" as a lazy paragraph.
    const view = mount("1. a\n2. b\n  - ddd\n3. ddd\n4. ddd", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 3); // the "  - ddd" ListItem
      const { markerLine, ownLines } = classifyItemLines(view.state, item);
      expect(markerLine).toBe(3);
      expect(ownLines).toEqual([]); // 3./4. are lazy (col 0 < content col) → excluded
    } finally {
      view.destroy();
    }
  });
  it("classifyItemLines keeps a genuinely nested child line", () => {
    const view = mount("- a\n  - child", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1); // "- a"
      const { markerLine, ownLines } = classifyItemLines(view.state, item);
      expect(markerLine).toBe(1);
      expect(ownLines).toEqual([2]); // "  - child" col 2 ≥ content col 2 → own
    } finally {
      view.destroy();
    }
  });
});

describe("ListEditPlan discriminant", () => {
  // The planners return a discriminated union — a structural no-op is
  // `{ kind: "noop" }`, not an empty `changes: []` the caller must recognise.
  // These pin the discriminant so applyShift's `plan.kind === "noop"` branch
  // (and the fact that a real transform is `kind: "edit"`) stays honest.
  it("planOutdentItem returns kind 'noop' on a top-level item", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 2) });
    try {
      const plan = planOutdentItem(view.state, view.state.selection.main.head);
      expect(plan.kind).toBe("noop");
    } finally {
      view.destroy();
    }
  });

  it("planOutdentItem returns kind 'edit' with changes on a real promotion", () => {
    const view = mount("- A\n  - B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 4) });
    try {
      const plan = planOutdentItem(view.state, view.state.selection.main.head);
      expect(plan.kind).toBe("edit");
      if (plan.kind === "edit") {
        expect(plan.changes.length).toBeGreaterThan(0);
      }
    } finally {
      view.destroy();
    }
  });

  it("planIndentItem returns kind 'noop' on the first item (nothing to nest under)", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(1).from + 2) });
    try {
      const plan = planIndentItem(view.state, view.state.selection.main.head);
      expect(plan.kind).toBe("noop");
    } finally {
      view.destroy();
    }
  });
});

// Generated shapes around a bare marker line, judged against commonmark.js: an
// item is empty exactly when CommonMark gives it no children. Lezer 1.8.1 spans a
// bare item over a blank line and the paragraph after it, so a rule read off
// `item.to` disagrees on a large share of these. Link reference definitions as
// the body are left out on purpose: Lezer gives `9.\n   [x]: /url` a
// LinkReference child on the next line and the editor must keep that line,
// while commonmark.js consumes the definition and reports no child.
describe("bare marker emptiness — commonmark.js shape table", () => {
  const markers = ["-", "9.", "1)", "*"];
  const pads = ["", " ", "   "];
  // Lines after the marker line; `C` becomes spaces up to the content column.
  const tails = [
    null,
    "",
    " \t",
    " ",
    "Cbody",
    "body",
    "C- child",
    "C> quote",
    "C```\nCcode\nC```",
    "C    code",
    "\nCbody",
    " \nCbody",
    "\n\nCbody",
    " \nCbody",
    "\nC- child",
    "\nbody",
    "C[ ] task",
    "\nC[ ] task",
  ];
  const contexts = [
    { before: "", lead: "", only: null },
    { before: "- a\n", lead: "", only: ["-"] },
    { before: "8. a\n", lead: "", only: ["9."] },
    { before: "1. parent\n", lead: "   ", only: null },
    { before: "1. parent\n\n", lead: "   ", only: null },
    { before: "", lead: "> ", only: null },
  ];

  type CmarkNode = ReturnType<CmarkParser["parse"]>;

  /** The innermost commonmark.js item starting on `lineNo`, or null. */
  function cmarkItem(node: CmarkNode, lineNo: number): CmarkNode | null {
    let found: CmarkNode | null = null;
    for (let c = node.firstChild; c !== null; c = c.next) {
      found = cmarkItem(c, lineNo) ?? found;
    }
    if (found === null && node.type === "item" && node.sourcepos[0][0] === lineNo) {
      return node;
    }
    return found;
  }

  const rows: { doc: string; markFrom: number; markerLine: number; empty: boolean }[] = [];
  for (const cx of contexts) {
    for (const marker of markers) {
      if (cx.only !== null && !cx.only.includes(marker)) {
        continue;
      }
      for (const pad of pads) {
        for (const tail of tails) {
          const contentCol = " ".repeat(marker.length + 1);
          const tailLines = (tail === null ? [] : tail.split("\n")).map((l) => {
            const body = l.replace(/^C/, contentCol);
            if (body === "") {
              return cx.lead === "> " ? ">" : "";
            }
            return cx.lead + body;
          });
          const doc = cx.before + [cx.lead + marker + pad, ...tailLines].join("\n");
          const markerLine = cx.before.split("\n").length;
          const markFrom = cx.before.length + cx.lead.length;
          const cm = cmarkItem(new CmarkParser().parse(doc), markerLine);
          if (cm !== null) {
            rows.push({ doc, markFrom, markerLine, empty: cm.firstChild === null });
          }
        }
      }
    }
  }

  it("generates the expected number of shapes", () => {
    expect(rows.length).toBe(756);
  });

  it.each(rows)("isEmptyItem matches commonmark.js for %j", ({
    doc,
    markFrom,
    markerLine,
    empty,
  }) => {
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
    const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
    let item = tree?.resolveInner(markFrom, 1) ?? null;
    while (item !== null && item.name !== "ListItem") {
      item = item.parent;
    }
    expect(item?.from).toBe(markFrom);
    const listItem = item as NonNullable<typeof item>;
    expect(isEmptyItem(state, listItem)).toBe(empty);
    if (empty) {
      expect(classifyItemLines(state, listItem)).toEqual({ markerLine, ownLines: [] });
    }
  });
});
