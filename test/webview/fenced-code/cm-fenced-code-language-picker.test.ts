// @vitest-environment happy-dom
// test/webview/fenced-code/cm-fenced-code-language-picker.test.ts
//
// happy-dom from line 1: the widget/command/lifecycle tests use document /
// EditorView / <select>. The pure model tests tolerate it. Every live-view /
// builder test carries `markdown({ base: markdownLanguage })` so syntaxTree() is
// populated (without it the picker never resolves) — same idiom as the
// copy-button suite.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { blockStyle } from "../../../src/webview/cm/decorations/block-style.js";
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import type { BuildContext } from "../../../src/webview/cm/decorations/types.js";
import { fencedHeaderBarThemeSpec } from "../../../src/webview/cm/theme.js";
import { fencedCodeCopyButton } from "../../../src/webview/cm/fenced-code/fenced-code-copy-button.js";
import {
  fenceLanguageTarget,
  fenceLanguageTargetAt,
  languageChangeSpec,
} from "../../../src/webview/cm/fenced-code/fenced-code-language.js";
import { setFenceLanguage } from "../../../src/webview/cm/fenced-code/fenced-code-language-command.js";
import {
  buildLanguagePickers,
  fencedCodeLanguagePicker,
} from "../../../src/webview/cm/fenced-code/fenced-code-language-picker.js";
import {
  LanguagePickerWidget,
  PICKER_CLASS,
  PICKER_LABEL_CLASS,
  PICKER_LABELED_CLASS,
  SQUARE_CODE_PATH_LEFT,
} from "../../../src/webview/cm/fenced-code/fenced-code-language-picker-widget.js";
import { LANGUAGE_OPTIONS } from "../../../src/webview/cm/fenced-code/fenced-code-languages.js";
import { fullTree } from "../helpers/full-tree.js";

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

// Apply the picker's edit at the helper level — the byte-clean round-trip proof.
function applyPick(doc: string, chosen: string): string {
  const { state, node } = firstFencedCode(doc);
  const target = fenceLanguageTarget(state, node);
  if (target === null) {
    throw new Error("no target");
  }
  const spec = languageChangeSpec(target, chosen);
  if (spec === null) {
    return doc;
  }
  return state.update({ changes: spec }).state.doc.toString();
}

// Pure BuildContext (markdown ext + fullTree) — the copy-button suite's idiom.
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

// Body-attached live view — parsing runs so syntaxTree() resolves; DOM lifecycle
// (toDOM/updateDOM/destroy) is driven by CM.
function mkView(doc: string, opts: { readOnly?: boolean; extra?: Extension[] } = {}): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(0),
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.readOnly.of(opts.readOnly ?? false),
      ...(opts.extra ?? []),
    ],
  });
  return new EditorView({ state, parent });
}

function mountPicker(doc: string, extra: Extension[] = []): EditorView {
  return mkView(doc, { extra: [fencedCodeLanguagePicker, ...extra] });
}

describe("LANGUAGE_OPTIONS", () => {
  it("leads with an empty-value 'Plain text' clear option", () => {
    expect(LANGUAGE_OPTIONS[0].value).toBe("");
    expect(LANGUAGE_OPTIONS[0].label).toBeTruthy();
  });
  it("every non-empty value is a plain language identifier (no spaces/braces)", () => {
    for (const o of LANGUAGE_OPTIONS) {
      if (o.value !== "") {
        expect(o.value).toMatch(/^[A-Za-z0-9_+#.-]+$/);
      }
    }
  });
  it("values are unique", () => {
    const values = LANGUAGE_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("fenceLanguageTarget", () => {
  it("bare fence: empty language, insertion point just after the open ```", () => {
    const { state, node } = firstFencedCode("```\nx\n```\n");
    const t = fenceLanguageTarget(state, node);
    expect(t).not.toBeNull();
    expect(t?.language).toBe("");
    expect(t?.tokenFrom).toBe(3);
    expect(t?.tokenTo).toBe(3);
    expect(t?.infoFrom).toBe(3);
    expect(t?.infoTo).toBe(3);
  });

  it("fence with a language: token span covers the language word", () => {
    const { state, node } = firstFencedCode("```js\nx\n```\n");
    const t = fenceLanguageTarget(state, node);
    expect(t?.language).toBe("js");
    expect(state.sliceDoc(t?.tokenFrom, t?.tokenTo)).toBe("js");
    expect(state.sliceDoc(t?.infoFrom, t?.infoTo)).toBe("js");
  });

  it("fence with trailing info attrs: token is only the FIRST word; info span is the whole string", () => {
    const { state, node } = firstFencedCode('```js title="x"\nx\n```\n');
    const t = fenceLanguageTarget(state, node);
    expect(t?.language).toBe("js");
    expect(state.sliceDoc(t?.tokenFrom, t?.tokenTo)).toBe("js");
    expect(state.sliceDoc(t?.infoFrom, t?.infoTo)).toBe('js title="x"');
  });

  it("leading space after the fence: CodeInfo starts past the space; token still the language word", () => {
    const { state, node } = firstFencedCode("``` js\nx\n```\n");
    const t = fenceLanguageTarget(state, node);
    expect(t?.language).toBe("js");
    expect(state.sliceDoc(t?.tokenFrom, t?.tokenTo)).toBe("js");
  });

  it("tilde fence with a language behaves identically", () => {
    const { state, node } = firstFencedCode("~~~python\nx\n~~~\n");
    const t = fenceLanguageTarget(state, node);
    expect(t?.language).toBe("python");
    expect(state.sliceDoc(t?.tokenFrom, t?.tokenTo)).toBe("python");
  });

  it("blockquote-nested fence resolves absolute offsets", () => {
    const { state, node } = firstFencedCode("> ```js\n> x\n> ```\n");
    const t = fenceLanguageTarget(state, node);
    expect(t?.language).toBe("js");
    expect(state.sliceDoc(t?.tokenFrom, t?.tokenTo)).toBe("js");
  });

  it("list-nested fence resolves absolute offsets", () => {
    const { state, node } = firstFencedCode("- ```js\n  x\n  ```\n");
    const t = fenceLanguageTarget(state, node);
    expect(t?.language).toBe("js");
    expect(state.sliceDoc(t?.tokenFrom, t?.tokenTo)).toBe("js");
  });

  it("attr-list info string (starts with '{') yields NO target (picker suppressed)", () => {
    const { state, node } = firstFencedCode("```{.js #id}\nx\n```\n");
    expect(fenceLanguageTarget(state, node)).toBeNull();
  });
});

describe("fenceLanguageTargetAt (lazy resolver)", () => {
  it("resolves the target from the open-line offset", () => {
    const { state } = firstFencedCode("```js\nx\n```\n");
    expect(fenceLanguageTargetAt(state, 0)?.language).toBe("js");
  });
  it("returns null when no fence starts at the offset's line", () => {
    const { state } = firstFencedCode("plain\n\n```js\nx\n```\n");
    expect(fenceLanguageTargetAt(state, 0)).toBeNull();
  });
});

describe("languageChangeSpec + round-trip (byte-clean)", () => {
  it("SET a language on a bare fence", () => {
    expect(applyPick("```\nx\n```\n", "js")).toBe("```js\nx\n```\n");
  });
  it("CHANGE an existing language", () => {
    expect(applyPick("```js\nx\n```\n", "python")).toBe("```python\nx\n```\n");
  });
  it("CLEAR a language back to a bare fence", () => {
    expect(applyPick("```js\nx\n```\n", "")).toBe("```\nx\n```\n");
  });
  it("CLEAR wipes the WHOLE info string (trailing attrs cannot become the new language)", () => {
    expect(applyPick('```js title="x"\nx\n```\n', "")).toBe("```\nx\n```\n");
  });
  it("CHANGE preserves trailing info attrs (only the language word is rewritten)", () => {
    expect(applyPick('```js title="x"\nx\n```\n', "ts")).toBe('```ts title="x"\nx\n```\n');
  });
  it("choosing the current language is a no-op (null spec)", () => {
    const { state, node } = firstFencedCode("```js\nx\n```\n");
    const t = fenceLanguageTarget(state, node);
    expect(languageChangeSpec(t as NonNullable<typeof t>, "js")).toBeNull();
  });
});

describe("setFenceLanguage command", () => {
  it("writes the language token against the live document", () => {
    const view = mkView("```\nx\n```\n");
    expect(setFenceLanguage(view, 0, "js")).toBe(true);
    expect(view.state.doc.toString()).toBe("```js\nx\n```\n");
    view.destroy();
  });
  it("is a no-op (returns false, no change) on a read-only surface", () => {
    const view = mkView("```\nx\n```\n", { readOnly: true });
    expect(setFenceLanguage(view, 0, "js")).toBe(false);
    expect(view.state.doc.toString()).toBe("```\nx\n```\n");
    view.destroy();
  });
  it("returns false when the chosen language equals the current one", () => {
    const view = mkView("```js\nx\n```\n");
    expect(setFenceLanguage(view, 0, "js")).toBe(false);
    view.destroy();
  });
  it("clears the language back to a bare fence", () => {
    const view = mkView("```js\nx\n```\n");
    expect(setFenceLanguage(view, 0, "")).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nx\n```\n");
    view.destroy();
  });
});

// Pull the <select> out of the picker wrapper (the one DOM shape toDOM returns).
function pickerSelect(root: HTMLElement): HTMLSelectElement {
  const sel = root.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
  if (sel === null) {
    throw new Error("no select in picker DOM");
  }
  return sel;
}

describe("LanguagePickerWidget", () => {
  it("eq is keyed on openFrom + language", () => {
    const w = new LanguagePickerWidget(0, "js");
    expect(w.eq(new LanguagePickerWidget(0, "js"))).toBe(true);
    expect(w.eq(new LanguagePickerWidget(0, "ts"))).toBe(false);
    expect(w.eq(new LanguagePickerWidget(5, "js"))).toBe(false);
  });

  it("ALWAYS returns the wrapper span with an inner select; is-labeled tracks language", () => {
    const view = mkView("```js\nx\n```\n");
    const tagged = new LanguagePickerWidget(0, "js").toDOM(view);
    expect(tagged.classList.contains(PICKER_LABEL_CLASS)).toBe(true);
    expect(tagged.classList.contains(PICKER_LABELED_CLASS)).toBe(true);
    const select = pickerSelect(tagged);
    expect(select.className).toBe(PICKER_CLASS);
    expect(select.value).toBe("js");
    expect(select.getAttribute("aria-label")).toBeTruthy();
    // Bare fence: same wrapper shape, NO is-labeled modifier (bare float unchanged).
    const bare = new LanguagePickerWidget(0, "").toDOM(view);
    expect(bare.classList.contains(PICKER_LABEL_CLASS)).toBe(true);
    expect(bare.classList.contains(PICKER_LABELED_CLASS)).toBe(false);
    view.destroy();
  });

  it("carries the decorative square-code icon (aria-hidden, inline SVG)", () => {
    const view = mkView("```js\nx\n```\n");
    const dom = new LanguagePickerWidget(0, "js").toDOM(view);
    const paths = [...dom.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    expect(paths).toContain(SQUARE_CODE_PATH_LEFT);
    expect(dom.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    view.destroy();
  });

  it("prepends the current language as an option when it is not in the curated list", () => {
    const view = mkView("```wat\nx\n```\n");
    const select = pickerSelect(new LanguagePickerWidget(0, "wat").toDOM(view));
    expect(select.value).toBe("wat");
    expect([...select.options].some((o) => o.value === "wat")).toBe(true);
    view.destroy();
  });

  it("change dispatches the token edit against the live document", () => {
    const view = mkView("```\nx\n```\n");
    const select = pickerSelect(new LanguagePickerWidget(0, "").toDOM(view));
    select.value = "js";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("```js\nx\n```\n");
    view.destroy();
  });

  it("updateDOM toggles is-labeled IN PLACE across the '' boundary (no recreate)", () => {
    const view = mkView("```\nx\n```\n");
    const dom = new LanguagePickerWidget(0, "").toDOM(view);
    expect(dom.classList.contains(PICKER_LABELED_CLASS)).toBe(false);
    // Same openFrom, language ''→js: updateDOM returns true and toggles in place.
    expect(new LanguagePickerWidget(0, "js").updateDOM(dom, view)).toBe(true);
    expect(dom.classList.contains(PICKER_LABELED_CLASS)).toBe(true);
    expect(pickerSelect(dom).value).toBe("js");
    // …and back: js→'' drops the modifier in place.
    expect(new LanguagePickerWidget(0, "").updateDOM(dom, view)).toBe(true);
    expect(dom.classList.contains(PICKER_LABELED_CLASS)).toBe(false);
    view.destroy();
  });

  it("updateDOM returns false on an openFrom change (CM recreates)", () => {
    const view = mkView("```js\nx\n```\n");
    const dom = new LanguagePickerWidget(0, "js").toDOM(view);
    expect(new LanguagePickerWidget(5, "js").updateDOM(dom, view)).toBe(false);
    view.destroy();
  });

  it("after destroy(), a stale change event no longer dispatches", () => {
    const view = mkView("```\nx\n```\n");
    const w = new LanguagePickerWidget(0, "");
    const dom = w.toDOM(view);
    const select = pickerSelect(dom);
    w.destroy(dom);
    select.value = "js";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("```\nx\n```\n"); // listener removed → no write
    view.destroy();
  });

  it("updateDOM keeps the SAME select (focus/keyboard preserved) when only the language changes", () => {
    const view = mountPicker("```js\nx\n```\n");
    const before = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    if (before === null) {
      throw new Error("no select");
    }
    // Change the language in SOURCE (not via the select) → rebuild → updateDOM.
    view.dispatch({ changes: { from: 3, to: 5, insert: "python" } }); // "```js" → "```python"
    const after = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    expect(after).toBe(before); // same DOM node (updateDOM, not destroy/recreate)
    expect(after?.value).toBe("python"); // value synced in place
    view.destroy();
  });
});

describe("buildLanguagePickers", () => {
  it("emits nothing on a read-only surface", () => {
    expect(buildLanguagePickers(buildCtx("```js\nx\n```\n", true))).toBe(Decoration.none);
  });
  it("emits one picker anchored at the open line.from (top-level)", () => {
    const doc = "intro\n\n```js\nx\n```\n";
    const openFrom = doc.indexOf("```");
    expect(widgetFroms(buildLanguagePickers(buildCtx(doc)))).toEqual([openFrom]);
  });
  it("emits one picker for a blockquote-nested fence, anchored at the open line.from", () => {
    expect(widgetFroms(buildLanguagePickers(buildCtx("> ```js\n> x\n> ```\n")))).toEqual([0]);
  });
  it("emits NO picker on an attr-list fence (non-plain info)", () => {
    expect(widgetFroms(buildLanguagePickers(buildCtx("```{.js #id}\nx\n```\n")))).toEqual([]);
  });
  it("identity round-trip: the document is never mutated by a build", () => {
    const ctx = buildCtx("```js\nx\n```\n");
    const before = ctx.state.doc.toString();
    buildLanguagePickers(ctx);
    expect(ctx.state.doc.toString()).toBe(before);
  });
});

describe("fencedCodeLanguagePicker (mounted plugin)", () => {
  it("mounts one picker on a writable fenced block, preselected", () => {
    const view = mountPicker("```js\nx\n```\n");
    const selects = view.dom.querySelectorAll<HTMLSelectElement>(`.${PICKER_CLASS}`);
    expect(selects.length).toBe(1);
    expect(selects[0].value).toBe("js");
    view.destroy();
  });

  it("emits NO picker on an attr-list fence when mounted", () => {
    const view = mountPicker("```{.js #id}\nx\n```\n");
    expect(view.dom.querySelectorAll(`.${PICKER_CLASS}`).length).toBe(0);
    view.destroy();
  });

  it("a select retained across an edit above the block cannot write (defence-in-depth)", () => {
    // An edit above the fence shifts openFrom → the widget moves → CM destroys the
    // old DOM. NOTE: this alone does NOT isolate the destroy() abort — after the
    // shift, openFrom 0 no longer resolves to a fence, so setFenceLanguage's
    // null-resolve guard ALSO blocks the write. It pins the combined "no stale
    // write" property; the next test isolates the abort specifically.
    const view = mountPicker("```\nx\n```\n");
    const stale = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    if (stale === null) {
      throw new Error("no select");
    }
    view.dispatch({ changes: { from: 0, insert: "intro\n" } }); // shift the fence down
    stale.value = "js";
    stale.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("intro\n```\nx\n```\n"); // stale select wrote nothing
    view.destroy();
  });

  it("destroy() via a full reseed aborts the listener even when openFrom still resolves to a fence (EH-80)", () => {
    // Isolates the destroy() abort: a full setState reseed makes CM discard every
    // widget DOM (destroy() → listeners aborted) and rebuild. The reseeded doc STILL
    // has a bare fence at offset 0, so the structural null-resolve guard does NOT
    // fire — ONLY the aborted listener prevents the retained select from writing.
    // Revert-check: remove the `pickerState.get(dom)?.controller.abort()` line in
    // destroy() and this goes red (the stale change writes "```js\ny\n```\n").
    const view = mountPicker("```\nx\n```\n");
    const stale = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    if (stale === null) {
      throw new Error("no select");
    }
    view.setState(
      EditorState.create({
        doc: "```\ny\n```\n",
        selection: EditorSelection.single(0),
        extensions: [markdown({ base: markdownLanguage }), fencedCodeLanguagePicker],
      })
    );
    stale.value = "js";
    stale.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("```\ny\n```\n"); // stale select wrote nothing
    view.destroy();
  });

  it("co-exists with reveal + blockStyle + the copy button at the same open-line slot", () => {
    const view = mountPicker("```js\nconst x = 1;\n```\n", [
      quollSyntaxReveal(),
      blockStyle,
      fencedCodeCopyButton,
    ]);
    expect(view.dom.querySelectorAll(`.${PICKER_CLASS}`).length).toBe(1);
    expect(view.dom.querySelectorAll(".quoll-copy-button").length).toBe(1);
    view.destroy();
  });
});

// Mode-cross via a REAL mounted <select> change event that crosses the ""
// boundary — the reentrant path (the select's change handler dispatches, which
// synchronously rebuilds decorations and re-runs updateDOM while the handler is
// still on the stack). The single DOM shape keeps this an IN-PLACE sync, so the
// same select is reused (focus preserved) and nothing is silently swallowed.
describe("quollFencedHeaderBarTheme (spec contract)", () => {
  const OPEN = ".cm-line.quoll-fenced-code-open.quoll-fenced-code-has-language";
  const spec = fencedHeaderBarThemeSpec as Record<string, Record<string, string> | undefined>;
  const rule = (k: string) => spec[k];

  it("makes the has-language open line its own positioning context (self-sufficient)", () => {
    expect(rule(OPEN)?.position).toBe("relative");
  });
  it("reserves header height as top padding", () => {
    expect(rule(OPEN)?.paddingTop).toContain("--quoll-fenced-header-height");
  });
  it("paints the bar as a background-image gradient (behind text; reuses surface tokens)", () => {
    const bg = rule(OPEN)?.backgroundImage ?? "";
    expect(bg).toContain("linear-gradient");
    expect(bg).toContain("--quoll-surface-header");
    expect(bg).toContain("--quoll-fenced-header-height");
  });
  it("collapses the bare wrapper out of layout (bare float unchanged)", () => {
    expect(rule(".quoll-language-picker-label:not(.is-labeled)")?.display).toBe("contents");
  });
  it("lays the labelled picker on the left", () => {
    const lab = rule(".quoll-language-picker-label.is-labeled");
    expect(lab?.position).toBe("absolute");
    expect(lab?.left).toBeDefined();
  });
  it("strips the labelled select box chrome, caps width, pins line-height", () => {
    const sel = rule(".quoll-language-picker-label.is-labeled .quoll-language-picker");
    expect(sel?.appearance).toBe("none");
    expect(sel?.border).toBe("none");
    expect(sel?.backgroundColor).toBe("transparent");
    expect(sel?.minWidth).toBe("0");
    expect(sel?.overflow).toBe("hidden");
    // Explicit after `font: inherit` so the concealed row's line-height:0 can't clip.
    expect(sel?.lineHeight).toBe("normal");
  });
  it("offsets fence-hidden controls by the gap when the next line is an outer-open header", () => {
    const key = Object.keys(fencedHeaderBarThemeSpec).find(
      (k) => k.includes(":has(") && k.includes("quoll-copy-button")
    );
    expect(key).toBeDefined();
    expect(rule(key as string)?.top).toContain("--quoll-block-gap-y");
  });
  it("re-adds the horizontal column inset to the fence-hidden labelled wrapper", () => {
    const key = Object.keys(fencedHeaderBarThemeSpec).find(
      (k) =>
        k.includes("quoll-fenced-code-fence-hidden") &&
        k.includes("quoll-language-picker-label") &&
        !k.includes(":has(")
    );
    expect(key).toBeDefined();
    expect(rule(key as string)?.left).toContain("--quoll-column-inset-left");
  });
});

describe("fencedCodeLanguagePicker mounted mode-cross (focus + no stale write)", () => {
  it("''→js via a real change keeps the SAME select and rewrites the doc", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = mountPicker("```\nx\n```\n");
    const before = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    if (before === null) {
      throw new Error("no select");
    }
    before.value = "js";
    before.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("```js\nx\n```\n");
    const after = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    expect(after).toBe(before); // in-place updateDOM, not destroy/recreate → focus kept
    expect(
      after?.closest(`.${PICKER_LABEL_CLASS}`)?.classList.contains(PICKER_LABELED_CLASS)
    ).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    view.destroy();
  });

  it("js→'' (Plain text) via a real change returns to bare, same select, doc cleared", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = mountPicker("```js\nx\n```\n");
    const before = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    if (before === null) {
      throw new Error("no select");
    }
    before.value = "";
    before.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.toString()).toBe("```\nx\n```\n");
    const after = view.dom.querySelector<HTMLSelectElement>(`.${PICKER_CLASS}`);
    expect(after).toBe(before);
    expect(
      after?.closest(`.${PICKER_LABEL_CLASS}`)?.classList.contains(PICKER_LABELED_CLASS)
    ).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    view.destroy();
  });
});
