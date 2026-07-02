// @vitest-environment happy-dom
// test/webview/cm-fenced-code-copy-button.test.ts
// (happy-dom from line 1: Task 2's widget tests use document/MouseEvent/navigator,
//  and Task 3 mounts a real EditorView. Task 1's pure helper tests tolerate it.)
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { blockStyle } from "../../src/webview/cm/decorations/block-style.js";
import {
  buildCopyButtons,
  fencedCodeBody,
  fencedCodeCopyButton,
} from "../../src/webview/cm/decorations/fenced-code-copy-button.js";
import {
  CHECK_ICON_PATH,
  COPY_ICON_PATH,
  CopyButtonWidget,
} from "../../src/webview/cm/decorations/fenced-code-copy-button-widget.js";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { collapseToggleThemeSpec, copyButtonThemeSpec } from "../../src/webview/cm/theme.js";
import { fullTree } from "./helpers/full-tree.js";

// Derive SyntaxNode from fullTree's return (a lezer Tree) — same reason as the
// source: `@lezer/common` is an un-hoisted transitive dep we never import.
type SyntaxNode = ReturnType<typeof fullTree>["topNode"];

function firstFencedCode(doc: string): { state: EditorState; node: SyntaxNode } {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
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

describe("fencedCodeBody", () => {
  it("extracts the body of a block WITH a language tag (fences + lang line excluded)", () => {
    const { state, node } = firstFencedCode("```js\nconst x = 1;\nfoo();\n```\n");
    expect(fencedCodeBody(state, node)).toBe("const x = 1;\nfoo();");
  });

  it("extracts the body of a block WITHOUT a language tag", () => {
    const { state, node } = firstFencedCode("```\nplain text\n```\n");
    expect(fencedCodeBody(state, node)).toBe("plain text");
  });

  it("returns an empty string for an empty fenced block", () => {
    const { state, node } = firstFencedCode("```\n```\n");
    expect(fencedCodeBody(state, node)).toBe("");
  });

  it("an unclosed block at EOF runs from the line after the fence to the last line", () => {
    const { state, node } = firstFencedCode("```js\nconst x = 1;\nfoo();");
    expect(fencedCodeBody(state, node)).toBe("const x = 1;\nfoo();");
  });

  it("an unclosed block ending with a trailing newline drops the phantom newline", () => {
    // Lezer's CodeText for an unclosed fence includes the EOF-terminating
    // newline that a closed fence excludes; without the unclosed-newline strip
    // this returns "const x = 1;\n" — a closed block with the same body returns
    // "const x = 1;", so the unclosed case must match (revert-check: drop the
    // strip and this goes red).
    const { state, node } = firstFencedCode("```js\nconst x = 1;\n");
    expect(fencedCodeBody(state, node)).toBe("const x = 1;");
  });

  it("a closed block with NO trailing newline extracts the body", () => {
    const { state, node } = firstFencedCode("```\na\n```");
    expect(fencedCodeBody(state, node)).toBe("a");
  });

  it("handles a TILDE-fenced block (~~~)", () => {
    const { state, node } = firstFencedCode("~~~\nplain\n~~~\n");
    expect(fencedCodeBody(state, node)).toBe("plain");
  });

  it("preserves a blank line inside the body", () => {
    const { state, node } = firstFencedCode("```\na\n\nb\n```\n");
    expect(fencedCodeBody(state, node)).toBe("a\n\nb");
  });

  it("strips the fence indentation from an indented top-level fence (CommonMark)", () => {
    // 3-space-indented fence: each body line has up to 3 leading spaces removed,
    // so the payload is the code, not the structural indent.
    const { state, node } = firstFencedCode("   ```js\n   const x = 1;\n   ```\n");
    expect(fencedCodeBody(state, node)).toBe("const x = 1;");
  });

  it("strips the blockquote `> ` prefix from a NESTED fence's body lines", () => {
    // The `>` is a sibling QuoteMark OUTSIDE the CodeText nodes, so the parser's
    // CodeText boundaries already exclude it — the payload is the code only.
    const { state, node } = firstFencedCode("> ```js\n> const x = 1;\n> foo();\n> ```\n");
    expect(fencedCodeBody(state, node)).toBe("const x = 1;\nfoo();");
  });

  it("strips the list-indent prefix from a NESTED fence's body lines", () => {
    const { state, node } = firstFencedCode("- ```js\n  const x = 1;\n  foo();\n  ```\n");
    expect(fencedCodeBody(state, node)).toBe("const x = 1;\nfoo();");
  });

  it("preserves a blank line inside a blockquote-nested body (bare `>` continuation)", () => {
    const { state, node } = firstFencedCode("> ```js\n> a\n>\n> b\n> ```\n");
    expect(fencedCodeBody(state, node)).toBe("a\n\nb");
  });

  it("keeps a nested body line's OWN code indentation (only the prefix is stripped)", () => {
    // `>     deep();` → the `> ` prefix is structure; the 4 leading spaces are
    // code. A naive fence-indent strip would corrupt them — the parser doesn't.
    const { state, node } = firstFencedCode("> ```js\n>     deep();\n> ```\n");
    expect(fencedCodeBody(state, node)).toBe("    deep();");
  });

  it("strips the fence indent from an INDENTED fence inside a blockquote", () => {
    // `>    ```js` — the `> ` marker plus 3 spaces of fence indent. Lezer strips
    // only `> `, keeping the 3 inner spaces in the body CodeText; the strip must
    // measure the fence indent from the blockquote content margin and remove them
    // so the payload is the code, not the structural indent. (Revert-check: the
    // old top-level-only guard returns "   const x = 1;".)
    const { state, node } = firstFencedCode(">    ```js\n>    const x = 1;\n>    ```\n");
    expect(fencedCodeBody(state, node)).toBe("const x = 1;");
  });

  it("preserves genuine code indent past an indented blockquote fence (no over-strip)", () => {
    // Fence indent 3, body line `>      deep();` = 3 structural + 2 code spaces.
    // Only the 3 fence-indent spaces come off; the 2-space code indent stays.
    const { state, node } = firstFencedCode(">    ```js\n>      deep();\n>    ```\n");
    expect(fencedCodeBody(state, node)).toBe("  deep();");
  });

  it("measures the indented blockquote fence indent on the OPEN line (blank first body line)", () => {
    // A bare-`>` blank first body line has a narrower continuation prefix than
    // `> `; measuring the fence indent from a body line would skew it. The open
    // line pins the fence indent at 3 regardless.
    const { state, node } = firstFencedCode(">    ```js\n>\n>    code();\n>    ```\n");
    expect(fencedCodeBody(state, node)).toBe("\ncode();");
  });
});

function pathDs(el: HTMLElement): string[] {
  return [...el.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");
}

describe("CopyButtonWidget", () => {
  it("renders a Lucide copy icon button with an accessible name (no text label)", () => {
    const dom = new CopyButtonWidget(0, "x").toDOM({} as EditorView) as HTMLButtonElement;
    expect(dom.tagName).toBe("BUTTON");
    expect(dom.getAttribute("aria-label")).toBe("Copy code");
    expect(pathDs(dom)).toContain(COPY_ICON_PATH);
  });

  it("copies exactly the code body on click and swaps to the Lucide check (Copied)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const dom = new CopyButtonWidget(0, "const x = 1;\nfoo();").toDOM(
        {} as EditorView
      ) as HTMLButtonElement;
      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // let the writeText promise + feedback microtask settle
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("const x = 1;\nfoo();");
      expect(dom.getAttribute("aria-label")).toBe("Copied");
      expect(dom.classList.contains("is-copied")).toBe(true);
      expect(pathDs(dom)).toContain(CHECK_ICON_PATH);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a visible 'Copy failed' state when the clipboard write rejects (no silent loss)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const dom = new CopyButtonWidget(0, "x").toDOM({} as EditorView) as HTMLButtonElement;
      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(dom.getAttribute("aria-label")).toBe("Copy failed");
      expect(dom.classList.contains("is-copy-failed")).toBe(true);
      expect(dom.classList.contains("is-copied")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("eq() is keyed on (docFrom, body)", () => {
    const a = new CopyButtonWidget(0, "x");
    expect(a.eq(new CopyButtonWidget(0, "x"))).toBe(true);
    expect(a.eq(new CopyButtonWidget(0, "y"))).toBe(false);
    expect(a.eq(new CopyButtonWidget(1, "x"))).toBe(false);
  });

  it("always carries the base copy-button class (no single-line variant)", () => {
    const btn = new CopyButtonWidget(0, "x").toDOM({} as EditorView) as HTMLButtonElement;
    expect(btn.classList.contains("quoll-copy-button")).toBe(true);
    expect(btn.classList.contains("quoll-copy-button-single-line")).toBe(false);
  });

  it("a rapid second click cancels the prior revert timer (no flash back to default)", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const dom = new CopyButtonWidget(0, "x").toDOM({} as EditorView) as HTMLButtonElement;
      // First click resolves → "Copied" and schedules a 1500ms revert.
      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(dom.getAttribute("aria-label")).toBe("Copied");
      // Click again just before the first revert deadline, then cross it. With
      // the click-start clearTimeout the stale revert is cancelled, so the
      // button stays "Copied" instead of flashing back to "Copy code". (Without
      // the fix the t=1500 revert fires while the second click is still pending
      // and the assertion goes red.)
      vi.advanceTimersByTime(1490);
      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      vi.advanceTimersByTime(20);
      expect(dom.getAttribute("aria-label")).toBe("Copied");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

function buildCtx(doc: string, readOnly = false): BuildContext {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(0),
    extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(readOnly)],
  });
  return {
    state,
    selection: state.selection,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

function widgetFroms(set: DecorationSet): number[] {
  const out: number[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push(iter.from);
    iter.next();
  }
  return out;
}

describe("buildCopyButtons", () => {
  it("emits ONE button anchored at the open fence line.from for a top-level block", () => {
    const doc = "intro\n\n```js\nconst x = 1;\n```\n\nafter";
    const openFrom = doc.indexOf("```");
    expect(widgetFroms(buildCopyButtons(buildCtx(doc)))).toEqual([openFrom]);
  });

  it("emits NOTHING in read-only mode", () => {
    const doc = "```js\nconst x = 1;\n```\n";
    expect(buildCopyButtons(buildCtx(doc, true))).toBe(Decoration.none);
  });

  it("emits a button for a blockquote-nested fence, anchored at the open line.from", () => {
    // node.from sits at the ``` (after `> `); the widget anchors at the LINE
    // start so the absolutely-positioned button rides the `.quoll-fenced-code-open`
    // line's top-right corner.
    const doc = "> ```js\n> const x = 1;\n> ```\n";
    expect(widgetFroms(buildCopyButtons(buildCtx(doc)))).toEqual([0]);
  });

  it("emits a button for a list-nested fence, anchored at the open line.from", () => {
    const doc = "- ```js\n  const x = 1;\n  ```\n";
    expect(widgetFroms(buildCopyButtons(buildCtx(doc)))).toEqual([0]);
  });

  it("identity round-trip: the document is never mutated", () => {
    const ctx = buildCtx("```js\nconst x = 1;\n```\n");
    const before = ctx.state.doc.toString();
    buildCopyButtons(ctx);
    expect(ctx.state.doc.toString()).toBe(before);
  });

  it("still emits when the visible range begins INSIDE the open fence line (no openFrom>=range.from gate)", () => {
    // CodeMirror's visibleRanges can begin mid-line (line-gap split on a long
    // wrapped line). A range starting just past the open fence line's start must
    // not drop the button — the line is still rendered. Revert-check: with the
    // removed `openFrom < range.from` gate restored, this goes red (empty).
    const doc = "intro\n\n```js\nconst x = 1;\n```\n\nafter";
    const openFrom = doc.indexOf("```");
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(0),
      extensions: [markdown({ base: markdownLanguage })],
    });
    const ctx: BuildContext = {
      state,
      selection: state.selection,
      visibleRanges: [{ from: openFrom + 2, to: state.doc.length }],
      tree: fullTree(state),
    };
    expect(widgetFroms(buildCopyButtons(ctx))).toEqual([openFrom]);
  });
});

function mountFenced(doc: string, caret: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
      quollSyntaxReveal(),
      blockStyle,
      fencedCodeCopyButton,
    ],
  });
  return new EditorView({ state, parent });
}

describe("fencedCodeCopyButton DOM integration", () => {
  it("renders the button inside the open fence line, co-located with the reveal replace, click-inert to the selection", () => {
    // Caret on the trailing paragraph → the open fence is HIDDEN (replace active)
    // so the widget is co-located with the replace.
    const doc = "intro\n\n```js\nconst x = 1;\n```\n\nafter";
    const view = mountFenced(doc, doc.indexOf("after") + 2);
    try {
      const buttons = view.dom.querySelectorAll<HTMLButtonElement>(".quoll-copy-button");
      expect(buttons.length).toBe(1);
      // The button still lives in the open fence line — now COLLAPSED (its ``` is
      // concealed), carrying the zero-height hidden class while staying the button's
      // positioning context. The panel's -open edge moved to the first body line.
      const line = buttons[0].closest(".cm-line");
      expect(line?.classList.contains("quoll-fenced-code-fence-hidden")).toBe(true);
      expect(line?.classList.contains("quoll-fenced-code-open")).toBe(false);
      // Clicking is inert to the document AND the selection (display-only).
      const selBefore = view.state.selection.main.head;
      const docBefore = view.state.sliceDoc();
      buttons[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe(docBefore);
      expect(view.state.selection.main.head).toBe(selBefore);
    } finally {
      view.destroy();
    }
  });

  it("gives single- and multi-body-line blocks the same button, no single-line variant", () => {
    // Caret parked on the trailing paragraph so BOTH blocks render concealed. The
    // single-line centring variant was removed (single-line now top-aligns like a
    // multi-line block), so neither carries the marker class.
    const singleDoc = "```js\nconst x = 1;\n```\n\npara";
    const single = mountFenced(singleDoc, singleDoc.indexOf("para") + 1);
    try {
      const btn = single.dom.querySelector<HTMLButtonElement>(".quoll-copy-button");
      expect(btn).not.toBeNull();
      expect(btn?.classList.contains("quoll-copy-button-single-line")).toBe(false);
    } finally {
      single.destroy();
    }
    const multiDoc = "```js\nconst x = 1;\nfoo();\n```\n\npara";
    const multi = mountFenced(multiDoc, multiDoc.indexOf("para") + 1);
    try {
      const btn = multi.dom.querySelector<HTMLButtonElement>(".quoll-copy-button");
      expect(btn?.classList.contains("quoll-copy-button")).toBe(true);
      expect(btn?.classList.contains("quoll-copy-button-single-line")).toBe(false);
    } finally {
      multi.destroy();
    }
  });

  it("re-collapses/reveals the open fence row as the caret moves on/off it", () => {
    const view = mountFenced(
      "```js\nconst x = 1;\n```\n\npara",
      "```js\nconst x = 1;\n```\n\npara".indexOf("para") + 1
    );
    try {
      const openLine = () => view.dom.querySelectorAll(".cm-line")[0];
      expect(openLine().classList.contains("quoll-fenced-code-fence-hidden")).toBe(true);
      view.dispatch({ selection: { anchor: 2 } }); // onto the open fence line
      expect(openLine().classList.contains("quoll-fenced-code-open")).toBe(true);
      expect(openLine().classList.contains("quoll-fenced-code-fence-hidden")).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("body caret reveals the open fence row; the copy button keeps its default (non-centred) anchor", () => {
    const doc = "```js\nconst x = 1;\nlet y = 2;\n```\n\npara";
    const view = mountFenced(doc, doc.indexOf("const") + 2); // caret in the body
    try {
      const openLine = view.dom.querySelectorAll(".cm-line")[0];
      // Open fence row revealed (block-scoped) — its position:relative anchor is the
      // `.quoll-fenced-code-open` rule, so the button still pins correctly.
      expect(openLine.classList.contains("quoll-fenced-code-fence-hidden")).toBe(false);
      expect(openLine.classList.contains("quoll-fenced-code-open")).toBe(true);
      const btn = view.dom.querySelector<HTMLButtonElement>(".quoll-copy-button");
      expect(btn).not.toBeNull();
      // Multi-body block → never the single-line centred variant.
      expect(btn?.classList.contains("quoll-copy-button-single-line")).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("emits NO button for a read-only mount", () => {
    const doc = "```js\nconst x = 1;\n```\n";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          markdown({ base: markdownLanguage }),
          EditorState.readOnly.of(true),
          quollSyntaxReveal(),
          blockStyle,
          fencedCodeCopyButton,
        ],
      }),
    });
    try {
      expect(view.dom.querySelectorAll(".quoll-copy-button").length).toBe(0);
    } finally {
      view.destroy();
    }
  });
});

describe("quollCopyButtonTheme", () => {
  it("makes the open fence line a positioning context and pins the button top-right", () => {
    expect(copyButtonThemeSpec[".cm-line.quoll-fenced-code-open"].position).toBe("relative");
    const btn = copyButtonThemeSpec[".quoll-copy-button"];
    expect(btn.position).toBe("absolute");
    expect(btn.top).toBeDefined();
    expect(btn.right).toBeDefined();
  });

  it("collapsed open-fence row keeps position:relative in the COPY theme so the button still anchors", () => {
    expect(copyButtonThemeSpec[".cm-line.quoll-fenced-code-fence-hidden"].position).toBe(
      "relative"
    );
  });

  it("collapsed open-fence row carries the 0.9em panel font-size so the button doesn't jitter on caret move", () => {
    // Codex #2: without this the button's em sizing would shift ~10% as the caret
    // enters/leaves the fence (collapsed line otherwise inherits the ~1em body size).
    expect(copyButtonThemeSpec[".cm-line.quoll-fenced-code-fence-hidden"].fontSize).toBe("0.9em");
  });

  it("has no border (borderless icon affordance)", () => {
    // Cast to widen off the exact literal type (the `border` key was dropped from
    // the spec): if it is ever re-added, `.border` becomes defined and this fails.
    const rule = copyButtonThemeSpec[".quoll-copy-button"] as Record<string, string | undefined>;
    expect(rule.border).toBeUndefined();
  });

  it("shares ONE foreground + hover-background token with the collapse toggle (single source)", () => {
    // entry: unify copy-button + collapse-bar colours. Both specs reference the
    // SAME shared value (not duplicated literals) so retuning one moves both.
    const copyFg = copyButtonThemeSpec[".quoll-copy-button"].color;
    const collapseFg = collapseToggleThemeSpec[".quoll-fenced-collapse-toggle"].color;
    expect(copyFg).toBe(collapseFg);
    const copyHoverBg =
      copyButtonThemeSpec[".quoll-copy-button:hover, .quoll-copy-button:focus-visible"]
        .backgroundColor;
    const collapseHoverBg =
      collapseToggleThemeSpec[
        ".quoll-fenced-collapse-toggle:hover, .quoll-fenced-collapse-toggle:focus-visible"
      ].backgroundColor;
    expect(copyHoverBg).toBe(collapseHoverBg);
  });
});
