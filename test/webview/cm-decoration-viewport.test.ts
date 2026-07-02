import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { syntaxRevealProviders } from "../../src/webview/cm/decorations/index.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { fullTree } from "./helpers/full-tree.js";

function bigMarkHeavyDoc(targetBytes: number): string {
  // Each repetition carries one of every syntax construct currently revealed
  // by a provider so the viewport contract is exercised uniformly across
  // headingReveal / blockquoteReveal / inlineMarkReveal / linkReveal /
  // taskCheckboxReveal / fencedCodeReveal. Adding the task-list construct (C5)
  // and the fenced-code block keeps the "tiny viewport emits far fewer
  // decorations than whole-doc" assertion non-vacuous for those providers —
  // without their construct in the fixture each would emit zero decorations in
  // BOTH the tiny and whole viewports, and `0 < 0 / 10` is false. The fenced
  // block's own ``` lines close before the next repetition's `# h`, so each
  // repeat parses as one self-contained FencedCode.
  const line =
    "# h\n> q\n**bold** *italic* `code` ~~strike~~ [t](https://x)\n- [ ] t\n```js\nc\n```\n";
  return line.repeat(Math.ceil(targetBytes / line.length));
}

function ctx(doc: string, visibleRanges: { from: number; to: number }[]): BuildContext {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(0),
    extensions: [markdown({ base: markdownLanguage })],
  });
  // fullTree forces a COMPLETE parse. The ratio assertion below
  // (tiny-viewport count < whole-doc count / 10) only holds once the whole
  // fixture is parsed: a partial tree (CM's bounded initial parse covers only
  // the leading few KB) would build BOTH the tiny and whole viewports from the
  // same leading fragment, collapsing the ratio to ~1 and failing the test.
  // fullTree throws if the 5s budget is somehow exhausted, surfacing an
  // incomplete parse as a clear error instead of a baffling ratio failure.
  const tree = fullTree(state);
  return { state, selection: state.selection, visibleRanges, tree };
}

function countDecorations(set: DecorationSet): number {
  let n = 0;
  const iter = set.iter();
  while (iter.value !== null) {
    n += 1;
    iter.next();
  }
  return n;
}

describe("decoration providers — viewport-only build (functional contract)", () => {
  it("for every provider, decorations outside the supplied visibleRanges are NOT emitted", () => {
    const doc = bigMarkHeavyDoc(100_000); // 100KB
    const window = { from: 1000, to: 2000 };
    const c = ctx(doc, [window]);
    for (const p of syntaxRevealProviders) {
      const set = p.build(c);
      const iter = set.iter();
      while (iter.value !== null) {
        // Every emitted decoration MUST be at least partly inside the window.
        // (Mark / replace ranges; same half-open overlap rule.)
        const inside = iter.from < window.to && window.from < iter.to;
        expect(inside).toBe(true);
        iter.next();
      }
    }
  });

  it("for every provider, a 1MB doc with a tiny viewport emits FAR fewer decorations than the same doc with whole-doc viewport", () => {
    const doc = bigMarkHeavyDoc(1_000_000); // 1MB
    const tiny = ctx(doc, [{ from: 0, to: 1000 }]);
    const whole = ctx(doc, [{ from: 0, to: doc.length }]);
    for (const p of syntaxRevealProviders) {
      const tinyCount = countDecorations(p.build(tiny));
      const wholeCount = countDecorations(p.build(whole));
      // 1MB has ~25k constructs; tiny viewport touches a handful. The ratio
      // is functional, not wall-clock — a regression that walks state.doc
      // would emit wholeCount decorations regardless of the supplied window.
      expect(tinyCount).toBeLessThan(wholeCount / 10);
    }
  });

  it("orchestrator wires syntaxRevealProviders through createSyntaxReveal — no provider returns null", () => {
    const c = ctx("# h\n> q\n**b** *i* `c` ~~s~~", [{ from: 0, to: 100 }]);
    for (const p of syntaxRevealProviders) {
      const out = p.build(c);
      expect(out).toBeTruthy();
      expect(typeof (out as DecorationSet).iter).toBe("function");
    }
  });
});
