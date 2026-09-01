// @vitest-environment happy-dom
//
// C8 part (a) re-audit: after every C4a–C7 widget landed, raw HTML in a
// document stays inert. Raw HTML is parsed by @lezer/markdown as HTML nodes,
// never as Markdown link/image — so no block-widget field builds a widget for
// it and renderCellInline never emits a live <a>/<img> from it. Paired with
// the structural guard in test/markdown/url-choke-point.test.ts (no innerHTML
// in src/**), this is the "no live-DOM promotion" final checkpoint.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { detectLeadingFrontmatterInState } from "../../src/webview/cm/frontmatter/detect.js";
import { frontmatterBlockField } from "../../src/webview/cm/frontmatter/index.js";
import { ImageBlockWidget } from "../../src/webview/cm/image/image-widget.js";
import { imageBlockField } from "../../src/webview/cm/image/index.js";
import { renderCellInline } from "../../src/webview/cm/table/cell-render.js";
import { tableBlockField } from "../../src/webview/cm/table/index.js";
import { settledState } from "./helpers/settled-state.js";
import { settledMount } from "./helpers/settled-view.js";

const RAW_HTML: readonly string[] = [
  '<a href="javascript:alert(1)">x</a>',
  '<img src="javascript:alert(1)">',
  "<script>alert(1)</script>",
  '<iframe src="data:text/html,x"></iframe>',
];

// Count ImageBlockWidget instances over a doc. Selection at doc end so
// reveal-on-caret never suppresses the widget (imageBlockField hides the block
// when the caret intersects the image line — cm-image-field.test.ts:46).
function imageWidgetCount(state: EditorState): number {
  let n = 0;
  const cur = state.field(imageBlockField).iter();
  while (cur.value) {
    if ((cur.value.spec as { widget?: unknown }).widget instanceof ImageBlockWidget) {
      n++;
    }
    cur.next();
  }
  return n;
}

function imageOnlyState(doc: string): EditorState {
  // `imageBlockField.create()` reads `syntaxTree(state)` on the STATE itself —
  // settle the field snapshot, not just the tree, or a truncated init-viewport
  // parse can under-count widgets under load.
  return settledState(
    EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: [markdown({ base: markdownLanguage }), imageBlockField],
    })
  );
}

function cellHtml(raw: string): string {
  const root = document.createElement("div");
  for (const n of renderCellInline(raw)) {
    root.appendChild(n);
  }
  return root.innerHTML;
}

describe("C8 raw-HTML inertness — block image field", () => {
  for (const html of RAW_HTML) {
    it(`builds no image widget for raw HTML: ${html.slice(0, 24)}`, () => {
      expect(imageWidgetCount(imageOnlyState(`${html}\n`))).toBe(0);
    });
  }
});

describe("C8 raw-HTML inertness — table cell", () => {
  for (const html of RAW_HTML) {
    it(`renders raw HTML in a cell inert (no live <a>/<img>): ${html.slice(0, 24)}`, () => {
      // Escape pipes so the cell parser keeps the HTML in one cell; the point
      // is that the HTML text never becomes a live element.
      const out = cellHtml(html.replace(/\|/g, "\\|"));
      expect(out).not.toContain("<a ");
      expect(out).not.toContain("<img");
      expect(out).not.toContain("<script");
      expect(out).not.toContain("<iframe");
    });
  }
});

const COMBINED = [
  "---",
  "title: doc",
  "draft: true",
  "---",
  "",
  "# Heading",
  "",
  "- [ ] task one",
  "- [x] task two",
  "",
  "| a | b |",
  "| :-- | --: |",
  "| 1 | 2 |",
  "",
  "![alt](https://x.test/a.png)",
  "",
  "See [docs](https://example.test/ok).",
  "",
  '<img src="https://x.test/raw.png">',
  '<iframe src="data:text/html,x"></iframe>',
  "",
].join("\n");

// ALL block fields co-registered, exercised through a real EditorView (the
// editor's real set, minus the inline checkbox ViewPlugin which is
// viewport-dependent and covered by Task 4 + the
// task-checkbox/cm-task-checkbox-widget-*.test.ts suite).
// Returns the parent too so the caller's finally can remove it (view.destroy()
// detaches CM's own DOM but leaves the parent attached → body grows across
// tests). Caret at end so no reveal suppresses.
function combinedView(): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc: COMBINED,
    selection: EditorSelection.cursor(COMBINED.length),
    extensions: [
      markdown({ base: markdownLanguage }),
      tableBlockField,
      imageBlockField,
      frontmatterBlockField,
    ],
  });
  // Constructing the view runs EditorView.decorations.from(field) for EVERY
  // block field together — a decoration-range conflict throws HERE, not at
  // EditorState.create. A clean build is the coexistence proof. `settledMount`
  // still constructs via `new EditorView(config)` under the hood, so that
  // construction-time throw is preserved; it additionally settles the parse so
  // the block fields' own `syntaxTree(state)` reads see a complete tree.
  return { view: settledMount({ state, parent }), parent };
}

describe("C8 enrollment under the full widget set (combined doc, all block fields co-registered)", () => {
  it("all block fields coexist — the view builds without a decoration conflict; frontmatter detected", () => {
    const { view, parent } = combinedView();
    try {
      expect(detectLeadingFrontmatterInState(view.state)).not.toBeNull();
    } finally {
      view.destroy();
      parent.remove();
    }
  });
  it("the table field builds a widget over the combined doc", () => {
    const { view, parent } = combinedView();
    try {
      expect(view.state.field(tableBlockField).size).toBeGreaterThan(0);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
  it("the image field builds exactly ONE widget — the markdown image, not the raw <img>/<iframe>", () => {
    // COMBINED has one markdown image and two raw-HTML image-ish tags; only the
    // markdown image enrolls — raw HTML is never an Image node.
    const { view, parent } = combinedView();
    try {
      expect(imageWidgetCount(view.state)).toBe(1);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

// Non-vacuity for the settle in `imageOnlyState`, taken STRUCTURALLY rather than by hoping
// a loaded machine reproduces the flake: `LanguageState.init` caps its init viewport at
// 3000 characters, so a longer document ALWAYS starts with a truncated snapshot no matter
// what the CPU is doing. This is the StateField-create class of the migration — the field
// is built at `EditorState.create` from `syntaxTree(state)`, so a complete tree obtained
// afterwards (what `fullTree` returns) arrives too late and cannot repair it.
//
// Note the direction of the failure: the truncated build yields FEWER widgets, so the
// suite's `toBe(0)` assertions above would keep passing while genuinely broken. That is why
// this guard asserts a POSITIVE count.
//
// Revert-check, measured: drop `settledState` from `imageOnlyState` and the third assertion
// below reds; nothing else in this file changes.
describe("the image-field harness reads a settled parse, not a truncated snapshot", () => {
  const PAD = "filler paragraph line\n\n".repeat(200); // > 3000 chars
  const DOC = `${PAD}![alt](https://example.com/a.png)\n`;

  /** The same fixture WITHOUT the settle — what `imageOnlyState` used to hand back. */
  function rawState(): EditorState {
    return EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(DOC.length),
      extensions: [markdown({ base: markdownLanguage }), imageBlockField],
    });
  }

  it("a freshly-created state's snapshot is truncated (the precondition)", () => {
    const raw = rawState();
    expect(syntaxTree(raw).length).toBeLessThan(raw.doc.length);
  });

  it("settling covers the whole doc", () => {
    const settled = settledState(rawState());
    expect(syntaxTree(settled).length).toBe(settled.doc.length);
  });

  it("the truncated snapshot loses the widget that the settled one builds", () => {
    expect(imageWidgetCount(rawState())).toBe(0); // the flake's shape
    expect(imageWidgetCount(imageOnlyState(DOC))).toBe(1);
  });
});
