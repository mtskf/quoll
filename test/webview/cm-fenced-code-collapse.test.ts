// @vitest-environment happy-dom
// test/webview/cm-fenced-code-collapse.test.ts
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fencedCodeBodyLineSpan } from "../../src/webview/cm/decorations/fenced-code-body.js";
import { fullTree } from "./helpers/full-tree.js";

type SyntaxNode = ReturnType<typeof fullTree>["topNode"];

function firstFencedCode(doc: string): { state: EditorState; node: SyntaxNode } {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const tree = fullTree(state);
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (found === null && n.name === "FencedCode") {
        found = n.node;
      }
    },
  });
  if (found === null) {
    throw new Error("no FencedCode node in fixture");
  }
  return { state, node: found };
}

describe("fencedCodeBodyLineSpan", () => {
  it("returns the first/last body line numbers for a closed block with a lang tag", () => {
    // line 1 = ```js, lines 2-3 = body, line 4 = ```
    const { state, node } = firstFencedCode("```js\nconst x = 1;\nfoo();\n```\n");
    expect(fencedCodeBodyLineSpan(state.doc, node)).toEqual({ startLine: 2, endLine: 3 });
  });

  it("returns null for an empty fenced block (no body)", () => {
    const { state, node } = firstFencedCode("```\n```\n");
    expect(fencedCodeBodyLineSpan(state.doc, node)).toBeNull();
  });

  it("handles an unclosed block at EOF (body runs to the last line)", () => {
    // line 1 = ```js, lines 2-3 = body, no closing fence
    const { state, node } = firstFencedCode("```js\nconst x = 1;\nfoo();");
    expect(fencedCodeBodyLineSpan(state.doc, node)).toEqual({ startLine: 2, endLine: 3 });
  });

  it("handles a tilde fence", () => {
    const { state, node } = firstFencedCode("~~~\nplain\n~~~\n");
    expect(fencedCodeBodyLineSpan(state.doc, node)).toEqual({ startLine: 2, endLine: 2 });
  });
});

import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import {
  COLLAPSE_THRESHOLD,
  fencedBlockGeometry,
  findCollapsibleFencedBlockAt,
  parkSelectionOutsideConceal,
} from "../../src/webview/cm/decorations/fenced-code-collapse-state.js";

// Build a doc whose first fenced block has `bodyLines` body lines (closed).
function fencedDoc(bodyLines: number, prefix = ""): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `line ${i + 1}`).join("\n");
  return `${prefix}\`\`\`js\n${body}\n\`\`\`\n`;
}

function stateWith(doc: string, caret = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [markdown({ base: markdownLanguage })],
  });
}

function firstFencedNode(state: EditorState): SyntaxNode {
  let found: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    enter: (n) => {
      if (found === null && n.name === "FencedCode") {
        found = n.node;
      }
    },
  });
  if (found === null) {
    throw new Error("no FencedCode");
  }
  return found;
}

describe("fencedBlockGeometry", () => {
  it("returns null for a block at the threshold (10 body lines → not collapsible)", () => {
    const state = stateWith(fencedDoc(10));
    expect(fencedBlockGeometry(state, firstFencedNode(state))).toBeNull();
  });

  it("returns geometry for a block over the threshold (11 body lines)", () => {
    const state = stateWith(fencedDoc(11));
    const g = fencedBlockGeometry(state, firstFencedNode(state));
    expect(g).not.toBeNull();
    // key = open fence line.from (offset 0 here, no prefix)
    expect(g?.key).toBe(0);
    // conceal starts at the 11th body line = document line 12 (line 1 is ```js).
    expect(g?.concealFrom).toBe(state.doc.line(12).from);
    // conceal ends at the last body line = document line 12 here (only 1 hidden line).
    expect(g?.concealTo).toBe(state.doc.line(12).to);
    // collapseTo extends over the closing fence = document line 13 (```).
    expect(g?.collapseTo).toBe(state.doc.line(13).to);
    // safeCaret = end of the 10th visible body line = document line 11.
    expect(g?.safeCaret).toBe(state.doc.line(11).to);
  });

  it("returns null for a blockquote-nested fence (top-level only)", () => {
    const body = Array.from({ length: 12 }, (_, i) => `> line ${i + 1}`).join("\n");
    const state = stateWith(`> \`\`\`js\n${body}\n> \`\`\`\n`);
    expect(fencedBlockGeometry(state, firstFencedNode(state))).toBeNull();
  });

  it("COLLAPSE_THRESHOLD is 10", () => {
    expect(COLLAPSE_THRESHOLD).toBe(10);
  });
});

describe("findCollapsibleFencedBlockAt", () => {
  it("resolves the block by its open-fence offset", () => {
    const state = stateWith(fencedDoc(11, "intro\n\n"));
    const key = state.doc.toString().indexOf("```");
    const g = findCollapsibleFencedBlockAt(state, key);
    expect(g?.key).toBe(key);
  });

  it("returns null when no collapsible block opens at the offset", () => {
    const state = stateWith(fencedDoc(11));
    expect(findCollapsibleFencedBlockAt(state, 999)).toBeNull();
  });

  it("DD1: resolves an INDENTED top-level fence by its line.from key (not resolveInner)", () => {
    // 2-space-indented fence (CommonMark allows up to 3). key = line.from = 0, which
    // is BEFORE node.from (the backticks). The tree-iterate match finds it; a
    // resolveInner(key, 1) would land in the leading whitespace and return null.
    // Revert-check: switch findCollapsibleFencedBlockAt back to resolveInner and
    // this goes red (g is null).
    const body = Array.from({ length: 11 }, (_, i) => `  line ${i}`).join("\n");
    const state = stateWith(`  \`\`\`js\n${body}\n  \`\`\`\n`);
    const g = findCollapsibleFencedBlockAt(state, 0);
    expect(g?.key).toBe(0);
  });
});

describe("parkSelectionOutsideConceal", () => {
  it("returns null when no head is inside the concealed region", () => {
    const sel = EditorSelection.single(5);
    expect(parkSelectionOutsideConceal(sel, 100, 200, 90)).toBeNull();
  });

  it("moves a single caret inside the region out to safeCaret", () => {
    const sel = EditorSelection.single(150);
    const out = parkSelectionOutsideConceal(sel, 100, 200, 90);
    expect(out?.main.head).toBe(90);
  });

  it("DD4: parks a SECONDARY head inside the region while keeping the outside main", () => {
    // main (index 0) at 5 (outside), secondary at 150 (inside [100,200]).
    const sel = EditorSelection.create([EditorSelection.cursor(5), EditorSelection.cursor(150)], 0);
    const out = parkSelectionOutsideConceal(sel, 100, 200, 90);
    expect(out).not.toBeNull();
    const heads = out?.ranges.map((r) => r.head).sort((a, b) => a - b);
    // outside main (5) kept; inside secondary moved to safeCaret (90).
    expect(heads).toEqual([5, 90]);
  });

  it("DD4: TWO inside heads + a higher-index OUTSIDE main merge safely (no out-of-bounds main)", () => {
    // The mainIndex-survives-merge case error-handler flagged. Two inside cursors
    // (150, 160 ∈ [100,170]) park to the SAME safeCaret (90) and MERGE; the outside
    // main (200, OUTSIDE [100,170]) is at the highest index. CM's normalized
    // decrements mainIndex on each merge index <= mainIndex, so `.main` stays
    // defined and points at the 200 caret.
    const sel = EditorSelection.create(
      [EditorSelection.cursor(150), EditorSelection.cursor(160), EditorSelection.cursor(200)],
      2
    );
    const out = parkSelectionOutsideConceal(sel, 100, 170, 90);
    expect(out).not.toBeNull();
    // No throw, main is in range and is the outside caret; the two inside merged to one.
    expect(out?.main.head).toBe(200);
    expect(out?.ranges.map((r) => r.head).sort((a, b) => a - b)).toEqual([90, 200]);
  });
});

import { EditorView } from "@codemirror/view";
import {
  CHEVRON_DOWN_PATH,
  CHEVRON_UP_PATH,
  FencedCollapseToggleWidget,
} from "../../src/webview/cm/decorations/fenced-code-collapse-widget.js";

function pathDs(el: HTMLElement): string[] {
  return [...el.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");
}

describe("FencedCollapseToggleWidget", () => {
  it("collapsed → renders a Show more button with a down chevron and hidden-line count", () => {
    const dom = new FencedCollapseToggleWidget(0, false, 5).toDOM({} as EditorView);
    expect(dom.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(dom.textContent).toContain("Show 5 more lines");
    expect(pathDs(dom)).toContain(CHEVRON_DOWN_PATH);
  });

  it("expanded → renders a Show less button with an up chevron", () => {
    const dom = new FencedCollapseToggleWidget(0, true, 5).toDOM({} as EditorView);
    expect(dom.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
    expect(dom.textContent).toContain("Show less");
    expect(pathDs(dom)).toContain(CHEVRON_UP_PATH);
  });

  it("collapsed bar root carries the -collapsed footer state class; expanded bar does not", () => {
    // The collapsed bar is the panel's visible bottom, so its root gets the state
    // class that quollCollapseToggleTheme rounds/pads (footer). The expanded "Show
    // less" bar carries NO `-collapsed` class: whether it is the footer is decided in
    // CSS from the rendered row below it (`:has(+ …)`), not from a widget class. Revert-
    // check: drop the classList.toggle in toDOM and the collapsed assertion goes red.
    const collapsed = new FencedCollapseToggleWidget(0, false, 5).toDOM({} as EditorView);
    const expanded = new FencedCollapseToggleWidget(0, true, 5).toDOM({} as EditorView);
    expect(collapsed.classList.contains("quoll-fenced-collapse-bar-collapsed")).toBe(true);
    expect(expanded.classList.contains("quoll-fenced-collapse-bar-collapsed")).toBe(false);
  });

  it("eq() is keyed on (key, expanded, hiddenCount)", () => {
    const a = new FencedCollapseToggleWidget(0, false, 5);
    expect(a.eq(new FencedCollapseToggleWidget(0, false, 5))).toBe(true);
    expect(a.eq(new FencedCollapseToggleWidget(0, true, 5))).toBe(false);
    expect(a.eq(new FencedCollapseToggleWidget(0, false, 6))).toBe(false);
    expect(a.eq(new FencedCollapseToggleWidget(1, false, 5))).toBe(false);
  });

  it("a left click dispatches the toggle (display-only: no doc change)", () => {
    const doc = `\`\`\`js\n${Array.from({ length: 11 }, (_, i) => `line ${i}`).join("\n")}\n\`\`\`\n`;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] }),
    });
    try {
      const dom = new FencedCollapseToggleWidget(0, false, 1).toDOM(view);
      const before = view.state.sliceDoc();
      dom
        .querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      // Display-only: the document is never mutated by a toggle.
      expect(view.state.sliceDoc()).toBe(before);
    } finally {
      view.destroy();
    }
  });
});

import type { DecorationSet } from "@codemirror/view";
import {
  buildFencedCollapse,
  fencedCodeCollapseField,
} from "../../src/webview/cm/decorations/fenced-code-collapse.js";
import { setFencedCollapseEffect } from "../../src/webview/cm/decorations/fenced-code-collapse-state.js";
import { hostDocumentReseed } from "../../src/webview/cm/frontmatter/reveal-state.js";

interface DecoDump {
  from: number;
  to: number;
  block: boolean;
  isReplace: boolean;
}

function dump(set: DecorationSet): DecoDump[] {
  const out: DecoDump[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { block?: boolean; widget?: unknown };
    // A replace decoration covers a range (from < to); a point widget has from === to.
    out.push({
      from: iter.from,
      to: iter.to,
      block: spec.block === true,
      isReplace: iter.from !== iter.to,
    });
    iter.next();
  }
  return out;
}

describe("buildFencedCollapse", () => {
  it("<= 10 body lines → no decoration", () => {
    const state = stateWith(fencedDoc(10));
    const { decorations } = buildFencedCollapse(state, new Set());
    expect(dump(decorations)).toEqual([]);
  });

  it("> 10 body lines, collapsed → ONE block replace over body lines 11..N + the closing fence", () => {
    const state = stateWith(fencedDoc(11));
    const { decorations, liveExpanded } = buildFencedCollapse(state, new Set());
    const d = dump(decorations);
    expect(d).toHaveLength(1);
    expect(d[0].block).toBe(true);
    expect(d[0].isReplace).toBe(true);
    expect(d[0].from).toBe(state.doc.line(12).from); // start of body line 11
    // Conceal range extends over the closing fence line (```) = document line 13, so
    // the bar is the sole footer and a caret on the ``` auto-expands (no double-round).
    expect(d[0].to).toBe(state.doc.line(13).to);
    expect([...liveExpanded]).toEqual([]); // nothing expanded → no live keys
  });

  it("> 10 body lines, expanded set has the key → a point widget (no conceal replace)", () => {
    const state = stateWith(fencedDoc(11));
    const { decorations, liveExpanded } = buildFencedCollapse(state, new Set([0]));
    const d = dump(decorations);
    expect(d).toHaveLength(1);
    expect(d[0].block).toBe(true);
    expect(d[0].isReplace).toBe(false); // point widget (Show less)
    expect(d[0].from).toBe(state.doc.line(12).to); // end of last body line
    expect([...liveExpanded]).toEqual([0]); // key reconciled as live
  });

  it("auto-expands when the selection head is inside the concealed region (fold parity)", () => {
    const state = stateWith(fencedDoc(11), 0);
    // caret on body line 11 (concealed when collapsed)
    const caret = state.doc.line(12).from + 1;
    const moved = stateWith(fencedDoc(11), caret);
    const { decorations, liveExpanded } = buildFencedCollapse(moved, new Set());
    expect(dump(decorations)[0].isReplace).toBe(false); // expanded via auto-expand
    expect([...liveExpanded]).toEqual([0]); // sticky: key added so it stays expanded
  });

  it("auto-expands when the caret parks ON the closing fence (extended conceal range → no double-rounded footer)", () => {
    const doc = fencedDoc(11);
    // Closing fence = doc line 13 (line 1 ```js, lines 2-12 body, line 13 ```).
    const caret = EditorState.create({ doc }).doc.line(13).from;
    const moved = stateWith(doc, caret);
    const { decorations, liveExpanded } = buildFencedCollapse(moved, new Set());
    // The collapsed conceal range extends over the closing fence, so a caret on it
    // is "inside" and auto-expands — the rounded Show-more footer bar can never
    // stack over a revealed rounded `.quoll-fenced-code-close`. Revert-check: keep
    // collapseTo at the last body line and this goes red (stays a conceal replace).
    expect(dump(decorations)[0].isReplace).toBe(false);
    expect([...liveExpanded]).toEqual([0]);
  });

  it("prunes a dead key (no matching block) from liveExpanded", () => {
    const state = stateWith(fencedDoc(11));
    const { liveExpanded } = buildFencedCollapse(state, new Set([0, 9999]));
    expect([...liveExpanded]).toEqual([0]); // 9999 has no block → dropped
  });

  it("identity round-trip: the document is never mutated", () => {
    const state = stateWith(fencedDoc(11));
    const before = state.doc.toString();
    buildFencedCollapse(state, new Set());
    expect(state.doc.toString()).toBe(before);
  });

  it("DD4: auto-expands when a SECONDARY selection head is inside the concealed region", () => {
    const doc = fencedDoc(11);
    const insidePos = EditorState.create({ doc }).doc.line(12).from + 1; // body line 11
    const state = EditorState.create({
      doc,
      // main range index 0 = the OUTSIDE caret; a secondary caret sits inside.
      selection: EditorSelection.create(
        [EditorSelection.cursor(0), EditorSelection.cursor(insidePos)],
        0
      ),
      extensions: [
        markdown({ base: markdownLanguage }),
        EditorState.allowMultipleSelections.of(true),
      ],
    });
    const { decorations, liveExpanded } = buildFencedCollapse(state, new Set());
    expect(dump(decorations)[0].isReplace).toBe(false); // expanded via the secondary head
    expect([...liveExpanded]).toEqual([0]);
  });
});

function stateWithField(doc: string, caret = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
      fencedCodeCollapseField,
    ],
  });
}

describe("fencedCodeCollapseField reducer", () => {
  it("DD3: a hostDocumentReseed transaction resets expanded state to all-collapsed", () => {
    let state = stateWithField(fencedDoc(11));
    // Expand the block.
    state = state.update({
      effects: setFencedCollapseEffect.of({ key: 0, expanded: true }),
    }).state;
    expect([...state.field(fencedCodeCollapseField).expanded]).toEqual([0]);
    // Reseed with NEW content (full replace + the reseed annotation).
    state = state.update({
      changes: { from: 0, to: state.doc.length, insert: fencedDoc(11, "changed\n\n") },
      annotations: hostDocumentReseed.of(true),
    }).state;
    // DD3: collapse state reset. Revert-check: drop the reseed branch and the
    // stale key 0 survives → this goes red ([0] instead of []).
    expect([...state.field(fencedCodeCollapseField).expanded]).toEqual([]);
  });

  it("DD2 fast-path: a selection move OUTSIDE any collapsed region reuses the DecorationSet", () => {
    let state = stateWithField(fencedDoc(11, "intro\n\n"), 0);
    const before = state.field(fencedCodeCollapseField).decorations;
    state = state.update({ selection: { anchor: 2 } }).state; // caret within leading prose
    // Identity reused — no walk, no new set. Revert-check: make update always
    // rebuild on selectionMoved and this goes red (a fresh DecorationSet).
    expect(state.field(fencedCodeCollapseField).decorations).toBe(before);
  });

  it("DD2 fast-path: a caret moving INTO the concealed region rebuilds and auto-expands", () => {
    let state = stateWithField(fencedDoc(11), 0);
    expect(dump(state.field(fencedCodeCollapseField).decorations)[0].isReplace).toBe(true);
    state = state.update({ selection: { anchor: state.doc.line(12).from } }).state; // body line 11
    expect(dump(state.field(fencedCodeCollapseField).decorations)[0].isReplace).toBe(false);
  });

  it("DD2 fast-path: a caret moving ONTO the closing fence rebuilds and auto-expands", () => {
    // The extended conceal range (fencedBlockGeometry.collapseTo) covers the closing
    // fence, so the selectionEntersCollapsed fast path fires for a caret parked on it
    // → auto-expand. Guards the double-rounded-footer fix end-to-end through the
    // reducer. Revert-check: shrink collapseTo back to the last body line and the
    // block stays collapsed (isReplace true).
    let state = stateWithField(fencedDoc(11), 0);
    expect(dump(state.field(fencedCodeCollapseField).decorations)[0].isReplace).toBe(true);
    state = state.update({ selection: { anchor: state.doc.line(13).from } }).state; // closing fence
    expect(dump(state.field(fencedCodeCollapseField).decorations)[0].isReplace).toBe(false);
  });

  it("DD5: inserting a space at the fence's exact line.from drifts the key → re-collapses", () => {
    // Pins the documented DD5 edge. The fence stays a fence (now 1-space indented,
    // CommonMark allows up to 3) but mapPos(0, 1) = 1 no longer matches the new
    // block's line.from (still 0), so the block re-collapses. Lossless + rare.
    // Caret is parked away from the (deep) conceal region, so this is purely the
    // key-drift path, not auto-expand.
    let state = stateWithField(fencedDoc(11), 0);
    state = state.update({
      effects: setFencedCollapseEffect.of({ key: 0, expanded: true }),
    }).state;
    expect([...state.field(fencedCodeCollapseField).expanded]).toEqual([0]);
    state = state.update({ changes: { from: 0, insert: " " } }).state;
    expect([...state.field(fencedCodeCollapseField).expanded]).toEqual([]);
  });
});

import { blockStyle } from "../../src/webview/cm/decorations/block-style.js";
// fencedCodeCollapseField already imported in the Task 4 block above
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { collapseToggleThemeSpec } from "../../src/webview/cm/theme.js";

function mountCollapse(doc: string, caret = 0, readOnly = false): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(readOnly),
      quollSyntaxReveal(),
      blockStyle,
      fencedCodeCollapseField,
    ],
  });
  return new EditorView({ state, parent });
}

function toggleButton(view: EditorView): HTMLButtonElement | null {
  return view.dom.querySelector<HTMLButtonElement>(".quoll-fenced-collapse-toggle");
}

describe("fencedCodeCollapseField DOM integration", () => {
  it("a >10-line block renders a Show more button and conceals the tail; <=10 shows none", () => {
    const long = `\`\`\`js\n${Array.from({ length: 11 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const short = `\`\`\`js\n${Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const v1 = mountCollapse(long);
    const v2 = mountCollapse(short);
    try {
      expect(toggleButton(v1)?.getAttribute("aria-expanded")).toBe("false");
      // line10 (the 11th body line, index 10) is concealed → absent from the DOM text.
      expect(v1.dom.textContent).not.toContain("line10");
      expect(v1.dom.textContent).toContain("line9"); // 10th body line stays visible
      expect(toggleButton(v2)).toBeNull(); // <=10 → no toggle at all
    } finally {
      v1.destroy();
      v2.destroy();
    }
  });

  it("clicking Show more expands (all lines + Show less); clicking Show less re-collapses — display-only", () => {
    const long = `\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const view = mountCollapse(long);
    try {
      const before = view.state.sliceDoc();
      // Expand.
      toggleButton(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("true");
      expect(view.dom.textContent).toContain("line11"); // concealed tail now visible
      // Collapse again.
      toggleButton(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("false");
      expect(view.dom.textContent).not.toContain("line11");
      // Display-only across the whole toggle cycle.
      expect(view.state.sliceDoc()).toBe(before);
    } finally {
      view.destroy();
    }
  });

  it("placing the caret inside the concealed region auto-expands the block (no trapped content)", () => {
    const long = `\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const view = mountCollapse(long);
    try {
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("false");
      // Move the caret onto a concealed body line (line11 = doc line 13).
      view.dispatch({ selection: { anchor: view.state.doc.line(13).from } });
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("true");
      expect(view.dom.textContent).toContain("line11");
    } finally {
      view.destroy();
    }
  });

  it("placing the caret ON the closing fence auto-expands (no collapsed footer under a revealed close fence)", () => {
    const long = `\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const view = mountCollapse(long);
    try {
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("false");
      // Closing fence = doc line 14 (line 1 ```js, lines 2-13 body, line 14 ```).
      view.dispatch({ selection: { anchor: view.state.doc.line(14).from } });
      // Auto-expanded: the Show-less bar (no -collapsed footer class) is what remains,
      // so the rounded footer never double-stacks with the revealed closing fence.
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("true");
      expect(view.dom.querySelector(".quoll-fenced-collapse-bar-collapsed")).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("DD6: collapse works on a READ-ONLY surface (display-only; toggle still shown)", () => {
    const long = `\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const view = mountCollapse(long, 0, true);
    try {
      // Unlike the copy button, the collapse toggle stays on a read-only surface.
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("false");
      const before = view.state.sliceDoc();
      toggleButton(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      // Expands via a StateEffect — NOT a document change (readOnly would veto one).
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("true");
      expect(view.dom.textContent).toContain("line11");
      expect(view.state.sliceDoc()).toBe(before);
    } finally {
      view.destroy();
    }
  });

  it("DD1: 'Show less' on an INDENTED fence re-collapses (no re-expand loop)", () => {
    // 12 indented body lines. With the resolveInner bug the collapse caret-park is
    // skipped → the deep caret stays in the conceal region → it auto-re-expands and
    // aria-expanded stays "true". The tree-iterate match parks the caret and it
    // collapses. Revert-check for DD1 at the integration level.
    const body = Array.from({ length: 12 }, (_, i) => `  line${i}`).join("\n");
    const view = mountCollapse(`  \`\`\`js\n${body}\n  \`\`\`\n`, 0);
    try {
      toggleButton(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("true");
      // Move the caret onto a line that is concealed when collapsed (doc line 13).
      view.dispatch({ selection: { anchor: view.state.doc.line(13).from } });
      toggleButton(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      view.destroy();
    }
  });

  it("DD4: 'Show less' with a SECONDARY caret inside the region still collapses (no re-expand loop)", () => {
    const long = `\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const view = mountCollapse(long, 0);
    try {
      // Expand so every line is editable.
      toggleButton(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("true");
      // main caret outside (offset 2), secondary caret on a deep line (doc line 13)
      // that is concealed when collapsed.
      view.dispatch({
        selection: EditorSelection.create(
          [EditorSelection.cursor(2), EditorSelection.cursor(view.state.doc.line(13).from)],
          0
        ),
      });
      // Show less: the secondary head is parked out too, so the block STAYS
      // collapsed. Revert-check: park only main.head and this stays "true".
      toggleButton(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      view.destroy();
    }
  });

  it("block-scoped reveal composes with the fold: a body caret reveals the OPEN fence while the block stays collapsed", () => {
    const long = `\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;
    const view = mountCollapse(long);
    try {
      // Caret in the VISIBLE body head (doc line 2 = "line0"), NOT in the concealed region.
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 1 } });
      // Fold stays collapsed — its auto-expand only fires for a head INSIDE the concealed region.
      expect(toggleButton(view)?.getAttribute("aria-expanded")).toBe("false");
      // The OPEN fence row (doc line 1, the first .cm-line) is REVEALED (block-scoped),
      // NOT the zero-height hidden class. Against the old per-line code this row would
      // carry `quoll-fenced-code-fence-hidden` (caret not on the fence line) → red.
      const openLine = view.dom.querySelectorAll(".cm-line")[0];
      expect(openLine.classList.contains("quoll-fenced-code-fence-hidden")).toBe(false);
      expect(openLine.classList.contains("quoll-fenced-code-open")).toBe(true);
      // AND the fence MARK itself is revealed (Codex #3): fenced-code-reveal wraps the
      // ``` in a `.quoll-syntax-reveal` span and the "```js" text is in the DOM. This
      // closes the combined mark+row test — asserting only the row class would pass
      // even if fenced-code-reveal stayed per-line and only block-style were fixed.
      expect(openLine.querySelector(".quoll-syntax-reveal")).not.toBeNull();
      expect(openLine.textContent).toContain("```js");
    } finally {
      view.destroy();
    }
  });
});

describe("quollCollapseToggleTheme", () => {
  it("styles the toggle bar so it blends with the code panel", () => {
    expect(collapseToggleThemeSpec[".quoll-fenced-collapse-toggle"]).toBeDefined();
    expect(collapseToggleThemeSpec[".quoll-fenced-collapse-toggle"].cursor).toBe("pointer");
  });

  it("insets the bar fill to the body-text column via a transparent border + background-clip (matches the code panel)", () => {
    // The bar is a block widget (NOT a .cm-line), so it must reproduce the code
    // panel's body-text-column inset itself or its full-width fill would jut 6px/2px
    // past the inset panel. Same transparent-border + background-clip:padding-box
    // mechanism as .cm-line.quoll-fenced-code (see theme.ts) — inset without a
    // margin, so the widget's getBoundingClientRect HEIGHT is untouched. REVERT-
    // CHECK: dropping the border/clip here turns these red. Real-pixel alignment is
    // verified in the browser harness (happy-dom has no layout).
    const bar = collapseToggleThemeSpec[".quoll-fenced-collapse-bar"] as Record<string, unknown>;
    expect(bar.borderLeft).toBe("var(--quoll-column-inset-left, 6px) solid transparent");
    expect(bar.borderRight).toBe("var(--quoll-column-inset-right, 2px) solid transparent");
    expect(bar.backgroundClip).toBe("padding-box");
    // Inset via border, never margin (which would move the widget's layout box).
    for (const forbidden of ["margin", "marginLeft", "marginRight", "width"]) {
      expect(forbidden in bar).toBe(false);
    }
  });

  it("rounds + pads the collapsed bar's bottom to match .quoll-fenced-code-close (panel footer)", () => {
    // The collapsed bar is the panel's visible bottom, so it carries the same
    // bottom radius + bottom padding as the closing fence line — BOTH drawn from the
    // shared --quoll-block-radius / --quoll-block-pad-y :root tokens, so a retuned
    // panel keeps its footer in lockstep. The radii are ELLIPTICAL
    // (`radius + 6px` / `radius + 2px` border-box horizontal) to compensate for
    // `background-clip: padding-box`: the border eats into the corner, so the outer
    // radius is bumped by the border width to leave a true --quoll-block-radius round
    // on the painted fill (see theme.ts). Real-pixel geometry is left to the browser
    // harness (happy-dom has no layout — fenced-collapse precedent).
    const footer = collapseToggleThemeSpec[".quoll-fenced-collapse-bar-collapsed"];
    expect(footer).toBeDefined();
    expect(footer.borderBottomLeftRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + var(--quoll-column-inset-left, 6px)) var(--quoll-block-radius, 8px)"
    );
    expect(footer.borderBottomRightRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + var(--quoll-column-inset-right, 2px)) var(--quoll-block-radius, 8px)"
    );
    expect(footer.paddingBottom).toBe("var(--quoll-block-pad-y, 12px)");
  });

  it("rounds the EXPANDED bar into the footer unless a revealed closing fence sits below it", () => {
    // The "Show less" bar is a side:1 widget after the last body line. When the caret
    // is OUTSIDE the block the closing fence collapses to a zero-height row and
    // block-style migrates `-close` UP onto the last body line (the row ABOVE the bar),
    // so the bar becomes the panel's visible bottom and must round — else it juts a
    // square rectangle under the rounded panel (the reported bug). When the caret is
    // INSIDE, the closing fence is a revealed rounded `.quoll-fenced-code-close`
    // directly BELOW the bar, so THAT is the footer and the bar stays flat. The
    // `:not(:has(+ .cm-line.quoll-fenced-code-close))` guard reads the rendered row
    // below the bar to pick between the two. Footer parity: same radii + padding as the
    // collapsed footer (shared collapseBarFooterCorner). Revert-check: drop this rule
    // and the caret-out expanded bar goes square (verified real-pixel in the harness).
    const key =
      ".quoll-fenced-collapse-bar:not(.quoll-fenced-collapse-bar-collapsed):not(:has(+ .cm-line.quoll-fenced-code-close))";
    const expandedFooter = collapseToggleThemeSpec[key];
    expect(expandedFooter).toBeDefined();
    // Byte-identical to the collapsed footer so the three footers never drift.
    expect(expandedFooter).toEqual(collapseToggleThemeSpec[".quoll-fenced-collapse-bar-collapsed"]);
  });

  it("un-rounds the code row directly above an expanded bar (no double-rounded interior row)", () => {
    // When the expanded bar is the footer (caret out), block-style's migrated `-close`
    // on the last body line — the row directly ABOVE the bar — must NOT also round, or
    // the panel double-rounds an interior seam. This higher-specificity rule zeroes that
    // row's bottom radius + padding. Keyed on `:has(+ …expanded bar)`, so it fires ONLY
    // for a code row immediately above a non-collapsed bar (never the collapsed footer,
    // never a revealed closing fence, which is always BELOW the bar). Revert-check: drop
    // this rule and the caret-out expanded panel double-rounds (verified in the harness).
    const key =
      ".cm-line.quoll-fenced-code-close:has(+ .quoll-fenced-collapse-bar:not(.quoll-fenced-collapse-bar-collapsed))";
    const unround = collapseToggleThemeSpec[key];
    expect(unround).toBeDefined();
    expect(unround.borderBottomLeftRadius).toBe("0");
    expect(unround.borderBottomRightRadius).toBe("0");
    expect(unround.paddingBottom).toBe("0");
  });

  it("toggle draws its resting dim + fade from the shared floating-control tokens", () => {
    // Unified with the copy button + corner toggles (styles.css :root). Previously
    // opacity 0.85 with no transition; now the shared token pair, so it fades on hover.
    const toggle = collapseToggleThemeSpec[".quoll-fenced-collapse-toggle"];
    expect(toggle.opacity).toMatch(/^var\(--quoll-control-rest-opacity/);
    expect(toggle.transition).toMatch(/^var\(--quoll-control-transition/);
  });
});
