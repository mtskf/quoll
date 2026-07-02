// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { ImageBlockWidget } from "../../src/webview/cm/image/image-widget.js";
import { imageBlockField, quollResourceBaseUri } from "../../src/webview/cm/image/index.js";

function widgetsOf(set: DecorationSet): ImageBlockWidget[] {
  const out: ImageBlockWidget[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const w = (iter.value.spec as { widget?: unknown }).widget;
    if (w instanceof ImageBlockWidget) {
      out.push(w);
    }
    iter.next();
  }
  return out;
}

function rangesOf(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

// Force a COMPLETE parse and republish it into the field BEFORE any synchronous
// read. imageBlockField.create() builds from the LAZY syntaxTree(state); the
// mount-time parse (LanguageState.init) only covers the first ~3000 chars within
// a wall-clock 20ms budget, so under CPU starvation the bounded initial parse can
// stop before reaching the image node (or even mid-fixture), leaving the field
// empty — a flake that only bit the full parallel suite. forceParsing(view,
// doc.length) advances the parse and dispatches so the field recomputes from the
// complete tree — the same "force AND publish" mechanism the production resync
// path uses. ensureSyntaxTree / fullTree alone would NOT fix it: they advance the
// parse but never republish into the field's snapshot. See LEARNING.md
// "syntaxTree(state) は LAZY" and PR #204 (cm-block-zone-arrow-keymap).
function forceParse(view: EditorView): EditorView {
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function mount(doc: string, selection?: EditorSelection | SelectionRange): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const base = EditorState.create({
    doc,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      imageBlockField,
    ],
  });
  const state = EditorState.create({
    doc,
    selection: selection ?? EditorSelection.cursor(base.doc.length),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      imageBlockField,
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

const SAFE = "![logo](https://x.test/a.png)";

describe("imageBlockField — emission", () => {
  it("emits exactly one block replace for a standalone allowlisted image", () => {
    const view = mount(`${SAFE}\n`);
    try {
      const w = widgetsOf(view.state.field(imageBlockField));
      expect(w).toHaveLength(1);
      expect(w[0].safeUrl).toBe("https://x.test/a.png");
      expect(w[0].alt).toBe("logo");
    } finally {
      view.destroy();
    }
  });

  it("covers whole-line boundaries", () => {
    const view = mount(`${SAFE}\n`);
    try {
      const ranges = rangesOf(view.state.field(imageBlockField));
      expect(ranges).toHaveLength(1);
      expect(ranges[0].from).toBe(0);
      expect(ranges[0].to).toBeGreaterThanOrEqual(SAFE.length);
    } finally {
      view.destroy();
    }
  });

  it("emits a (blocked) widget with safeUrl=null for a standalone javascript: image", () => {
    const view = mount("![x](javascript:alert(1))\n");
    try {
      const w = widgetsOf(view.state.field(imageBlockField));
      expect(w).toHaveLength(1);
      expect(w[0].safeUrl).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it.each([
    ["data: url", "![x](data:text/html,<script>1</script>)"],
    ["protocol-relative", "![x](//evil.test/x.png)"],
    ["entity-encoded scheme", "![x](javascript&#58;alert(1))"],
    ["backslash-escaped scheme", "![x](javascript\\:alert(1))"],
    ["unknown-entity scheme bypass", "![x](javascript&unknownentity;:alert(1))"],
  ])("blocks %s (safeUrl=null, render-gate via shared decode→gate)", (_label, src) => {
    const view = mount(`${src}\n`);
    try {
      const w = widgetsOf(view.state.field(imageBlockField));
      expect(w).toHaveLength(1);
      expect(w[0].safeUrl).toBeNull();
    } finally {
      view.destroy();
    }
  });
});

describe("imageBlockField — standalone eligibility", () => {
  it("does NOT emit for an inline image surrounded by text", () => {
    const view = mount(`here is ${SAFE} inline\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for two images on one line", () => {
    const view = mount(`${SAFE} ${SAFE}\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for an image with a soft-break sibling in the same paragraph", () => {
    // `![..](..)\nmore` is ONE paragraph (soft break); promoting just the image
    // line would split the paragraph. Excluded by the parent-paragraph check.
    const view = mount(`${SAFE}\nmore text in the same paragraph\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for an image inside a blockquote (> prefix marker)", () => {
    const view = mount(`> ${SAFE}\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for an image inside a list item (- prefix marker)", () => {
    const view = mount(`- ${SAFE}\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("DOES emit for a 1-3 space indented standalone image (insignificant indent)", () => {
    const view = mount(`   ${SAFE}\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for a NBSP-prefixed image (\\u00A0 is significant content, not ASCII-trimmable)", () => {
    // `.trim()` would strip the NBSP and wrongly promote this; trimAsciiWs keeps
    // it as content so the line-trim check excludes it (Codex re-review N1).
    const view = mount(` ${SAFE}\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for a VT-prefixed image (\\u000B is significant content, not ASCII-structural)", () => {
    // Lezer keeps a leading vertical tab inside the Paragraph (verified), so it
    // is significant content; trimAsciiWs (space/tab/LF/CR only) must NOT strip
    // it — else the line would be mis-promoted (Codex re-review N4).
    const view = mount(`${SAFE}\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for a reference image ![alt][ref] (no URL child)", () => {
    const view = mount("![alt][ref]\n\n[ref]: https://x.test/a.png\n");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for an empty-destination image ![alt]() (no URL child)", () => {
    // Lezer parses `![alt]()` with no URL child; it stays raw source (an empty
    // destination is harmless and is left to the user to complete).
    const view = mount("![alt]()\n");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("does NOT emit for a standalone image INSIDE a leading-frontmatter span (C8a guard)", () => {
    // The frontmatter block (frontmatterBlockField) owns the outermost block
    // over [0, closer]; a standalone image in the body must not also emit a
    // competing block decoration. Blank line before the closer so Lezer parses
    // the image as its own paragraph rather than a setext heading.
    const view = mount(`---\n${SAFE}\n\n---\n\n# body\n`);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });
});

describe("imageBlockField — alt extraction", () => {
  it("extracts plain alt text", () => {
    const view = mount("![my logo](https://x.test/a.png)\n");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].alt).toBe("my logo");
    } finally {
      view.destroy();
    }
  });

  it("preserves an empty alt", () => {
    const view = mount("![](https://x.test/a.png)\n");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].alt).toBe("");
    } finally {
      view.destroy();
    }
  });

  it("CommonMark-normalizes alt: flattens emphasis markers (*em* -> em)", () => {
    const view = mount("![*em*](https://x.test/a.png)\n");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].alt).toBe("em");
    } finally {
      view.destroy();
    }
  });

  it("CommonMark-normalizes alt: decodes a backslash escape (a\\*b -> a*b)", () => {
    const view = mount("![a\\*b](https://x.test/a.png)\n");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].alt).toBe("a*b");
    } finally {
      view.destroy();
    }
  });

  it("CommonMark-normalizes alt: decodes a character entity (a&amp;b -> a&b)", () => {
    const view = mount("![a&amp;b](https://x.test/a.png)\n");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].alt).toBe("a&b");
    } finally {
      view.destroy();
    }
  });
});

describe("imageBlockField — reveal-on-caret", () => {
  it("hides the widget when the caret is on the image line", () => {
    const view = mount(`${SAFE}\n`, EditorSelection.cursor(3));
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("hides when caret is AT the line's first character (boundary)", () => {
    const view = mount(`${SAFE}\n`, EditorSelection.cursor(0));
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(0);
    } finally {
      view.destroy();
    }
  });

  it("re-emits after the caret moves off the image line", () => {
    const doc = `${SAFE}\n\ntail\n`;
    const view = mount(doc, EditorSelection.cursor(doc.length));
    try {
      expect(widgetsOf(view.state.field(imageBlockField))).toHaveLength(1);
    } finally {
      view.destroy();
    }
  });

  it("multi-cursor: hides only the image whose line a cursor touches", () => {
    const doc = `${SAFE}\n\n${SAFE}\n`;
    const secondFrom = SAFE.length + 2;
    // Genuinely TWO ranges so the per-range overlap loop is exercised (Codex
    // re-review N3): a cursor on the blank line (touches NEITHER image) plus a
    // cursor on the second image's line. A single-range selection would leave
    // the loop's multi-range path untested.
    const view = mount(
      doc,
      EditorSelection.create(
        [EditorSelection.cursor(SAFE.length + 1), EditorSelection.cursor(secondFrom + 1)],
        0
      )
    );
    try {
      const w = widgetsOf(view.state.field(imageBlockField));
      expect(w).toHaveLength(1);
      expect(w[0].docFrom).toBe(0); // first image stays; second is revealed
    } finally {
      view.destroy();
    }
  });
});

describe("imageBlockField — round-trip", () => {
  it("never mutates the document (byte-identical) through render + reveal toggle", () => {
    const doc = `${SAFE}\n`;
    const view = mount(doc, EditorSelection.cursor(doc.length));
    try {
      expect(view.state.sliceDoc()).toBe(doc); // rendered, caret off line
      view.dispatch({ selection: { anchor: 3 } }); // caret onto image line → reveal
      expect(view.state.sliceDoc()).toBe(doc);
      view.dispatch({ selection: { anchor: doc.length } }); // caret off → re-render
      expect(view.state.sliceDoc()).toBe(doc);
    } finally {
      view.destroy();
    }
  });
});

function mountWithBase(doc: string, base: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(0), // caret at top: image line revealed only if it overlaps; keep off the image
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage }),
      quollResourceBaseUri.of(base),
      imageBlockField,
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

describe("imageBlockField — relative resolution", () => {
  const BASE = "https://csp/ws/notes/a.md";

  it("resolves a ./relative image against the document base URI", () => {
    // caret at top would reveal an image on line 1; put the image on line 3.
    const view = mountWithBase("text\n\n![d](./img.png)\n", BASE);
    try {
      const w = widgetsOf(view.state.field(imageBlockField));
      expect(w).toHaveLength(1);
      expect(w[0].safeUrl).toBe("https://csp/ws/notes/img.png");
    } finally {
      view.destroy();
    }
  });

  it("resolves a bare relative (no ./), and a ../parent path (resolved here; VS Code blocks the actual fetch at runtime since it is outside localResourceRoots)", () => {
    // The field cannot know localResourceRoots (host-side), so it resolves
    // `../x.png` to a same-origin URI; the broken-image icon at runtime (VS
    // Code refusing the out-of-folder fetch) is the documented limitation, NOT
    // the inert placeholder. The unit assertion checks resolution only.
    const view = mountWithBase("text\n\n![d](sub/p.png)\n\n![e](../x.png)\n", BASE);
    try {
      const urls = widgetsOf(view.state.field(imageBlockField))
        .map((w) => w.safeUrl)
        .sort();
      expect(urls).toEqual(["https://csp/ws/notes/sub/p.png", "https://csp/ws/x.png"].sort());
    } finally {
      view.destroy();
    }
  });

  it("renders a fragment-only ![](#frag) image inert (would resolve to the document file)", () => {
    const view = mountWithBase("text\n\n![d](#frag)\n", BASE);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].safeUrl).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("renders a query-only ![](?x=1) image inert (would resolve to the document file)", () => {
    const view = mountWithBase("text\n\n![d](?x=1)\n", BASE);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].safeUrl).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("passes an absolute http(s) URL through unchanged (remote, CSP decides)", () => {
    const view = mountWithBase("text\n\n![d](https://x.test/a.png)\n", BASE);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].safeUrl).toBe("https://x.test/a.png");
    } finally {
      view.destroy();
    }
  });

  it("leaves a relative image unresolved (safeUrl=null) when no base is set", () => {
    const view = mountWithBase("text\n\n![d](./img.png)\n", "");
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].safeUrl).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("blocks a javascript: image even with a base set (gate runs first)", () => {
    const view = mountWithBase("text\n\n![d](javascript:alert(1))\n", BASE);
    try {
      expect(widgetsOf(view.state.field(imageBlockField))[0].safeUrl).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
