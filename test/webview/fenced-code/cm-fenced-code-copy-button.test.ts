// @vitest-environment happy-dom
// test/webview/fenced-code/cm-fenced-code-copy-button.test.ts
// (happy-dom from line 1: Task 2's widget tests use document/MouseEvent/navigator,
//  and Task 3 mounts a real EditorView. Task 1's pure helper tests tolerate it.)
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { blockStyle } from "../../../src/webview/cm/decorations/block-style.js";
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import type { BuildContext } from "../../../src/webview/cm/decorations/types.js";
import {
  buildCopyButtons,
  fencedCodeBody,
  fencedCodeBodyAt,
  fencedCodeCopyButton,
} from "../../../src/webview/cm/fenced-code/fenced-code-copy-button.js";
import {
  CHECK_ICON_PATH,
  COPY_ICON_PATH,
  CopyButtonWidget,
} from "../../../src/webview/cm/fenced-code/fenced-code-copy-button-widget.js";
import {
  asFencedCodeNode,
  type FencedCodeNode,
  type OpenLineOffset,
} from "../../../src/webview/cm/fenced-code/fenced-code-node.js";
import { collapseToggleThemeSpec, copyButtonThemeSpec } from "../../../src/webview/cm/theme.js";
import { fullTree } from "../helpers/full-tree.js";

function firstFencedCode(doc: string): { state: EditorState; node: FencedCodeNode } {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const tree = fullTree(state);
  let found: FencedCodeNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (found === null) {
        const fenced = asFencedCodeNode(n);
        if (fenced !== null) {
          found = fenced;
        }
      }
    },
  });
  if (found === null) {
    throw new Error("no FencedCode node in fixture");
  }
  return { state, node: found };
}

/** Cast a raw offset to the branded OpenLineOffset. The boundary-value tests
 *  probe invalid / mid-block offsets that openLineOffsetOf can't produce, so they
 *  construct the branded value directly. */
const off = (n: number): OpenLineOffset => n as OpenLineOffset;

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

describe("fencedCodeBodyAt", () => {
  function makeState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
    });
  }

  it("returns null for openFrom < 0 (out-of-bounds low)", () => {
    const state = makeState("```js\nconst x = 1;\n```\n");
    expect(fencedCodeBodyAt(state, off(-1))).toBeNull();
  });

  it("returns null for openFrom > doc.length (out-of-bounds high)", () => {
    const state = makeState("```js\nconst x = 1;\n```\n");
    expect(fencedCodeBodyAt(state, off(state.doc.length + 1))).toBeNull();
  });

  it("returns null when no FencedCode starts on the given line (plain paragraph)", () => {
    const state = makeState("just a paragraph\n\n```js\nconst x = 1;\n```\n");
    // openFrom points at the start of the paragraph line, not a fenced block
    expect(fencedCodeBodyAt(state, off(0))).toBeNull();
  });

  it("resolves the body of a top-level fence (openFrom = open line start)", () => {
    const doc = "```js\nconst x = 1;\n```\n";
    const state = makeState(doc);
    expect(fencedCodeBodyAt(state, off(0))).toBe("const x = 1;");
  });

  it("resolves the body of a blockquote-nested fence", () => {
    const doc = "> ```js\n> const x = 1;\n> foo();\n> ```\n";
    const state = makeState(doc);
    // The open line starts at offset 0 (the `> ` prefix is on the same line)
    expect(fencedCodeBodyAt(state, off(0))).toBe("const x = 1;\nfoo();");
  });

  it("resolves the body of a list-nested fence", () => {
    const doc = "- ```js\n  const x = 1;\n  foo();\n  ```\n";
    const state = makeState(doc);
    expect(fencedCodeBodyAt(state, off(0))).toBe("const x = 1;\nfoo();");
  });

  it("returns null when openFrom points to a body line (not the open fence line)", () => {
    const doc = "```js\nconst x = 1;\n```\n";
    const state = makeState(doc);
    // offset 6 = start of body line "const x = 1;"; FencedCode overlaps walk
    // range but its open line is at 0 — the guard must reject this.
    expect(fencedCodeBodyAt(state, off(6))).toBeNull();
  });
});

function pathDs(el: HTMLElement): string[] {
  return [...el.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");
}

// toDOM now returns a wrapper hosting the button + a visually-hidden live region.
// These helpers pull each part back out so the assertions read against the right
// node (the button for label/icon/classes, the region for SR announcements).
function widgetDOM(widget: CopyButtonWidget): HTMLElement {
  return widget.toDOM({} as EditorView) as HTMLElement;
}
function copyButton(root: HTMLElement): HTMLButtonElement {
  const btn = root.querySelector<HTMLButtonElement>(".quoll-copy-button");
  if (btn === null) {
    throw new Error("no .quoll-copy-button in widget DOM");
  }
  return btn;
}
function statusRegion(root: HTMLElement): HTMLElement {
  const status = root.querySelector<HTMLElement>(".quoll-copy-status");
  if (status === null) {
    throw new Error("no .quoll-copy-status in widget DOM");
  }
  return status;
}

describe("CopyButtonWidget", () => {
  it("renders a Lucide copy icon button with an accessible name (no text label)", () => {
    const btn = copyButton(widgetDOM(new CopyButtonWidget(off(0), () => "x")));
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("aria-label")).toBe("Copy code");
    expect(pathDs(btn)).toContain(COPY_ICON_PATH);
  });

  it("carries an empty, visually-hidden polite live region before any copy", () => {
    // Present-but-empty at build time so the first copy is an observable mutation
    // (an SR only announces a CHANGE to a live region already in the tree).
    const region = statusRegion(widgetDOM(new CopyButtonWidget(off(0), () => "x")));
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("");
  });

  it("copies exactly the code body on click and swaps to the Lucide check (Copied)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      // The body is resolved lazily at click; a stub resolver stands in for the
      // live tree walk (fencedCodeBodyAt is covered by the DOM-integration suite).
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "const x = 1;\nfoo();"));
      const btn = copyButton(root);
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // let the writeText promise + feedback microtask settle
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("const x = 1;\nfoo();");
      expect(btn.getAttribute("aria-label")).toBe("Copied");
      expect(btn.classList.contains("is-copied")).toBe(true);
      expect(pathDs(btn)).toContain(CHECK_ICON_PATH);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("announces the copy success in the polite live region (unfocused label swap is not enough)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      copyButton(root).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      const region = statusRegion(root);
      expect(region.textContent).toBe("Copied");
      expect(region.getAttribute("aria-live")).toBe("polite");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a visible 'Copy failed' state when the clipboard write rejects (no silent loss)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      const btn = copyButton(root);
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(btn.getAttribute("aria-label")).toBe("Copy failed");
      expect(btn.classList.contains("is-copy-failed")).toBe(true);
      expect(btn.classList.contains("is-copied")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("announces the copy failure ASSERTIVELY in the live region", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      copyButton(root).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      const region = statusRegion(root);
      expect(region.textContent).toBe("Copy failed");
      // Assertive so a failed copy the user asked for is surfaced immediately.
      expect(region.getAttribute("aria-live")).toBe("assertive");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears the live region (back to polite) after the feedback window so a repeat copy re-announces", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      const region = statusRegion(root);
      copyButton(root).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(region.textContent).toBe("Copied");
      // After the 1500ms revert the region is emptied — the next identical copy is
      // then a real mutation (empty → "Copied") the SR will re-announce.
      await vi.advanceTimersByTimeAsync(1500);
      expect(region.textContent).toBe("");
      expect(region.getAttribute("aria-live")).toBe("polite");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("re-announces a repeated identical copy by clearing the region at click start", async () => {
    // A second copy with the SAME result must still announce. The region is cleared
    // synchronously at click start, so the settle re-writes "Copied" into an EMPTY
    // region — an observable empty→text mutation the SR re-announces, even before the
    // 1500ms revert fires. Without the click-start clear the second write is identical
    // to the region's current text (no mutation → no re-announce).
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      const btn = copyButton(root);
      const region = statusRegion(root);
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(region.textContent).toBe("Copied");
      // Second click, BEFORE the settle: the region is emptied synchronously.
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(region.textContent).toBe("");
      await Promise.resolve();
      await Promise.resolve();
      // The settle re-writes "Copied" — a fresh mutation, so it re-announces.
      expect(region.textContent).toBe("Copied");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a rapid second click does not let a stale revert blank the live region", async () => {
    // Region counterpart of the button "rapid second click cancels the prior revert
    // timer" test: the second click's click-start clearTimeout kills the first revert,
    // so it can never fire at t=1500 and empty the region while the second copy is the
    // live one. The region stays "Copied" instead of being blanked.
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      const btn = copyButton(root);
      const region = statusRegion(root);
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(region.textContent).toBe("Copied");
      // Re-copy just before the first revert deadline, then cross it.
      vi.advanceTimersByTime(1490);
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(20);
      expect(region.textContent).toBe("Copied");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("sets aria-live to assertive BEFORE writing the failure text (politeness-before-text order)", async () => {
    // announce()'s doc comment calls the aria-live-before-textContent order
    // load-bearing (an assertive announcement must be assertive by the time the text
    // lands). Reading only final state can't catch a reorder, so spy on the status
    // node's setAttribute + textContent setter and pin the order.
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      const region = statusRegion(root);
      const order: string[] = [];
      const realSetAttribute = region.setAttribute.bind(region);
      vi.spyOn(region, "setAttribute").mockImplementation((name, value) => {
        if (name === "aria-live") {
          order.push(`live:${value}`);
        }
        realSetAttribute(name, value);
      });
      let text = "";
      Object.defineProperty(region, "textContent", {
        configurable: true,
        get: () => text,
        set: (value: string) => {
          text = value;
          if (value !== "") {
            order.push(`text:${value}`);
          }
        },
      });
      copyButton(root).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      // The click-start clear emits an initial `live:polite`; the failure settle then
      // emits assertive THEN the text. Assert that trailing pair: aria-live is set to
      // assertive BEFORE the text lands.
      expect(order.slice(-2)).toEqual(["live:assertive", "text:Copy failed"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-announces correctly when a failed copy is immediately followed by a successful re-click", async () => {
    // Compound outcome sequence: first click fails (assertive "Copy failed"),
    // then — before any revert — a second click succeeds. The click-start
    // announce(status, "", false) must synchronously reset aria-live back to
    // polite and clear the text, so the failure's assertive announcement
    // doesn't leak into the success state.
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      const btn = copyButton(root);
      const region = statusRegion(root);

      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(region.textContent).toBe("Copy failed");
      expect(region.getAttribute("aria-live")).toBe("assertive");

      // Second click, BEFORE the second settle: click-start clear fires synchronously.
      // Assert BOTH the text clear AND the polite reset at this instant — the whole
      // point is that the failure's assertive politeness must not leak into the
      // success window (a later success settle re-sets polite anyway, so only this
      // synchronous check pins the click-start reset).
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(region.textContent).toBe("");
      expect(region.getAttribute("aria-live")).toBe("polite");

      await Promise.resolve();
      await Promise.resolve();
      expect(region.textContent).toBe("Copied");
      expect(region.getAttribute("aria-live")).toBe("polite");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps aria-atomic=true through the whole announce → revert cycle", async () => {
    // aria-atomic (read the short phrase as one unit) is set at build time only.
    // announce() must not disturb it across the copy lifecycle — pin it after the
    // announce AND after the 1500ms revert so a later 'cleanup' edit can't drop it.
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const root = widgetDOM(new CopyButtonWidget(off(0), () => "x"));
      const region = statusRegion(root);
      copyButton(root).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(region.textContent).toBe("Copied");
      expect(region.getAttribute("aria-atomic")).toBe("true");
      await vi.advanceTimersByTimeAsync(1500);
      expect(region.textContent).toBe("");
      expect(region.getAttribute("aria-atomic")).toBe("true");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("eq() is keyed on openFrom alone (a body edit reuses the DOM; a shift rebuilds)", () => {
    const resolve = () => "x";
    const a = new CopyButtonWidget(off(5), resolve);
    // Same open-line offset → reuse the DOM even though the body changed underneath
    // (the body is resolved lazily at click, never stored). This is the perf pin:
    // typing INSIDE the block must not rebuild the widget or re-materialise its body.
    expect(a.eq(new CopyButtonWidget(off(5), () => "different body"))).toBe(true);
    // A positional shift (an edit ABOVE the block) → rebuild so the reused click
    // handler never resolves the block at a stale offset.
    expect(a.eq(new CopyButtonWidget(off(9), resolve))).toBe(false);
  });

  it("always carries the base copy-button class (no single-line variant)", () => {
    const btn = copyButton(widgetDOM(new CopyButtonWidget(off(0), () => "x")));
    expect(btn.classList.contains("quoll-copy-button")).toBe(true);
    expect(btn.classList.contains("quoll-copy-button-single-line")).toBe(false);
  });

  it("a rapid second click cancels the prior revert timer (no flash back to default)", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      const btn = copyButton(widgetDOM(new CopyButtonWidget(off(0), () => "x")));
      // First click resolves → "Copied" and schedules a 1500ms revert.
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(btn.getAttribute("aria-label")).toBe("Copied");
      // Click again just before the first revert deadline, then cross it. With
      // the click-start clearTimeout the stale revert is cancelled, so the
      // button stays "Copied" instead of flashing back to "Copy code". (Without
      // the fix the t=1500 revert fires while the second click is still pending
      // and the assertion goes red.)
      vi.advanceTimersByTime(1490);
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      vi.advanceTimersByTime(20);
      expect(btn.getAttribute("aria-label")).toBe("Copied");
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

  it("copies the CURRENT body after an in-place body edit (lazy resolution, not a stale payload)", async () => {
    // The widget stores no body — it resolves fencedCodeBodyAt(view.state, openFrom)
    // at click. Editing the body keeps openFrom fixed, so the DOM is REUSED (perf
    // win); the click must still copy the edited body, proving the resolve reads the
    // live tree, not a build-time snapshot.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const doc = "```js\nconst x = 1;\n```\n\npara";
    const view = mountFenced(doc, doc.indexOf("para") + 1);
    try {
      // Capture BEFORE the body edit so DOM reuse is observable.
      const btnBefore = view.dom.querySelector<HTMLButtonElement>(".quoll-copy-button");
      expect(btnBefore).not.toBeNull();

      const from = doc.indexOf("const x = 1;");
      view.dispatch({
        changes: { from, to: from + "const x = 1;".length, insert: "const y = 2;" },
      });

      // Must be the SAME node: eq() returns true (openFrom unchanged after a body
      // edit) → CM reuses the existing DOM node rather than rebuilding it. This is
      // the perf contract: typing INSIDE the block must not rebuild the widget.
      const btnAfter = view.dom.querySelector<HTMLButtonElement>(".quoll-copy-button");
      expect(btnAfter).toBe(btnBefore);

      btnAfter?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith("const y = 2;");
    } finally {
      view.destroy();
      vi.unstubAllGlobals();
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

  it("body caret reveals the open fence row; the copy button keeps its top-right anchor", () => {
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
      // The single-line marker variant was removed, so no block ever carries it.
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

  it("draws its resting dim + fade from the shared floating-control tokens (no per-control literal)", () => {
    const btn = copyButtonThemeSpec[".quoll-copy-button"];
    expect(btn.opacity).toMatch(/^var\(--quoll-control-rest-opacity/);
    expect(btn.transition).toMatch(/^var\(--quoll-control-transition/);
  });

  it("hides the copy live region off-screen (clip) while keeping it in the a11y tree", () => {
    // The SR status node must be invisible to sighted users but still announced —
    // the canonical sr-only clip: 1px box, hidden overflow, clip rect, out of flow
    // so it never disturbs the collapsed open-fence row's zero height.
    const region = copyButtonThemeSpec[".quoll-copy-status"] as Record<string, string | undefined>;
    expect(region.position).toBe("absolute");
    expect(region.width).toBe("1px");
    expect(region.height).toBe("1px");
    expect(region.overflow).toBe("hidden");
    expect(region.clip).toBe("rect(0, 0, 0, 0)");
  });

  it("pins the wrapper to position:static so it never becomes the button's anchor", () => {
    // The button is absolutely positioned and must anchor to the open-fence panel row,
    // not the wrapper. An explicit static rule guards against a later relative/absolute
    // creeping in. Assert the rule directly (no `?.` fallback) so a missing rule fails.
    expect(copyButtonThemeSpec[".quoll-copy-button-wrap"].position).toBe("static");
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

  it("neutralises the resting edge (no native bevel, border, or shadow — bare-icon at rest)", () => {
    // A native `<button>` carries a raised-key bevel (native `appearance`) and the VS
    // Code webview default may add a `border`/`box-shadow`. Left un-reset, that resting
    // edge highlight gives the bare icon a heavier "raised key" weight. All three are
    // stripped EXPLICITLY (mirroring the `backgroundColor: transparent` neutralisation)
    // so the resting button reads as a flat icon; the boxed affordance appears only on
    // hover/focus. Re-adding any resting edge (or dropping a neutraliser) fails here.
    const rule = copyButtonThemeSpec[".quoll-copy-button"] as Record<string, string | undefined>;
    expect(rule.appearance).toBe("none");
    expect(rule.border).toBe("none");
    expect(rule.boxShadow).toBe("none");
  });

  it("neutralises the resting background to transparent (icon-only at rest; the box only appears on hover/focus)", () => {
    // The resting `backgroundColor` used to be a filled secondary-button fill that read
    // as an ugly bordered box. It is now `transparent` — set EXPLICITLY, not omitted,
    // because this is a real `<button>` and the VS Code webview injects a default
    // `button { background: var(--vscode-button-background) }`; omitting would let that
    // primary fill paint at rest. Pinning `transparent` (not `undefined`) guards that
    // neutralisation: revert to an omitted or coloured resting background and this fails.
    expect(copyButtonThemeSpec[".quoll-copy-button"].backgroundColor).toBe("transparent");
    // The hover/focus affordance is untouched — the box still appears on interaction,
    // and it is a real colour token (not transparent), so hover stays visible.
    const hoverBg =
      copyButtonThemeSpec[".quoll-copy-button:hover, .quoll-copy-button:focus-visible"]
        .backgroundColor;
    expect(hoverBg).toBeDefined();
    expect(hoverBg).not.toBe("transparent");
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
