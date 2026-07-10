// Real-browser CONTRACT tests for three cosmetic CodeMirror dist-DOM couplings —
// theme/fold rules that reach into CM's *rendered* DOM structure (adjacency
// combinators, CM-emitted gutter classes, a positioned gutter overlay). None are
// checkable in happy-dom: it has no layout engine and drops the structural facts
// these rules key on (see memory quoll-happy-dom-*). Each test renders the real
// widget in headless Chromium and fails if a future CM bump silently changes the
// DOM shape a shipped rule depends on. Cosmetic-only: a break here is a visual
// regression, not a data-integrity one — hence the LOW-priority contract gate.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { blockStyle } from "../../src/webview/cm/decorations/block-style.js";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { fencedCodeCollapseField } from "../../src/webview/cm/fenced-code/fenced-code-collapse.js";
import { quollFolding } from "../../src/webview/cm/fold/index.js";
import { quollTheme } from "../../src/webview/cm/theme.js";

/** Drain CM's bounded measure queue so getComputedStyle()/adjacency read a settled
 *  DOM (same 4-frame idiom as list-hang-layout.browser.test.ts). */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    let n = 4;
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  for (const n of document.body.querySelectorAll(".cm-couplings-probe")) {
    n.remove();
  }
});

function mount(doc: string, extensions: Extension[], caret = 0): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-couplings-probe";
  parent.style.width = "600px";
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions,
    }),
    parent,
  });
}

// ── Coupling (1): theme.ts collapse-bar `:has(+ .cm-line.quoll-fenced-code-close)` ──
// The "Show less" bar (a BLOCK widget) and its vertically-adjacent code rows must be
// direct `.cm-content` children with NO interposed `.cm-widgetBuffer`, or the `+`/
// `:has(+ …)` adjacency combinators that pick the rounded footer (theme.ts
// collapseToggleThemeSpec) silently stop matching. CM inserts `.cm-widgetBuffer`
// around block widgets in some configurations; this pins that it does NOT here.
describe("collapse-bar adjacency has no interposed .cm-widgetBuffer (theme.ts :has(+ …))", () => {
  // A >10-body-line fenced block is collapsible; parking the caret ON the closing
  // fence auto-expands it AND reveals the `.quoll-fenced-code-close` row directly
  // below the "Show less" bar — the exact adjacency the footer rules read.
  const long = `\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")}\n\`\`\`\n`;

  it("the bar's siblings are code lines, not widget buffers, and the combinator resolves", async () => {
    const closingFence = EditorState.create({ doc: long }).doc.line(14).from;
    view = mount(
      long,
      [
        markdown({ base: markdownLanguage }),
        EditorState.allowMultipleSelections.of(true),
        quollSyntaxReveal(),
        blockStyle,
        fencedCodeCollapseField,
      ],
      closingFence
    );
    await settled();

    const content = view.contentDOM;
    const bar = content.querySelector<HTMLElement>(".quoll-fenced-collapse-bar");
    expect(bar).not.toBeNull();
    const prev = bar?.previousElementSibling;
    const next = bar?.nextElementSibling;

    // Both neighbours are real `.cm-line` rows — NOT `.cm-widgetBuffer`. If a CM bump
    // wrapped the block widget in buffers, these flip and the footer `+` breaks.
    expect(prev?.classList.contains("cm-line")).toBe(true);
    expect(prev?.classList.contains("cm-widgetBuffer")).toBe(false);
    expect(next?.classList.contains("cm-line")).toBe(true);
    expect(next?.classList.contains("cm-widgetBuffer")).toBe(false);
    // The revealed closing fence sits immediately below the bar (rule 1's target).
    expect(next?.classList.contains("quoll-fenced-code-close")).toBe(true);
    // No `.cm-widgetBuffer` anywhere in the panel's row stream.
    expect(content.querySelectorAll(".cm-widgetBuffer").length).toBe(0);

    // The exact adjacency combinator both footer rules are written against resolves
    // against the rendered DOM structure (this checks the STRUCTURE the selector keys
    // on — the direct-sibling relationship — not that any stylesheet is mounted). It is
    // non-vacuous: interpose a `.cm-widgetBuffer` or rename the close-fence class and
    // `:has(+ …)` stops matching. (Test-analyzer confirmed via mutation: renaming
    // FENCED_CODE_CLOSE_CLASS in block-style.ts reddens this test.)
    expect(bar?.matches(":has(+ .cm-line.quoll-fenced-code-close)")).toBe(true);
  });
});

// Fold-gutter couplings (2) + (3) share one mount: a foldable heading document with
// the real fold extension, which renders `.cm-gutters` + `.cm-foldGutter`.
describe("fold gutter dist-DOM couplings", () => {
  // Mount the real base theme (quollTheme) alongside the fold extension, exactly as
  // editor.ts composes them in production, so coupling (2)'s border-neutralising rule
  // is actually applied and its effect on the rendered gutter can be measured.
  function mountFold(): EditorView {
    return mount(`# Heading\n\nbody line\nmore body\n`, [
      markdown({ base: markdownLanguage }),
      quollFolding(),
      quollTheme,
    ]);
  }

  // ── Coupling (2): theme.ts `.cm-gutters.cm-gutters-before` / `-after` ──
  // The gutter border-neutralising rules win on specificity by mirroring CM's OWN
  // double-class (`.cm-gutters.cm-gutters-before`). If CM stopped emitting the
  // positional `cm-gutters-before` class, the specificity mirror would silently
  // under-match and the grey gutter band (CM's 1px right border) would return.
  it("(2) the .cm-gutters.cm-gutters-before double class is present and the border is neutralised", async () => {
    view = mountFold();
    await settled();
    const gutters = view.dom.querySelector<HTMLElement>(".cm-gutters");
    expect(gutters).not.toBeNull();
    // Structural fact the selector keys on: CM emits BOTH classes on the wrapper.
    expect(gutters?.classList.contains("cm-gutters")).toBe(true);
    expect(gutters?.classList.contains("cm-gutters-before")).toBe(true);
    expect(gutters?.matches(".cm-gutters.cm-gutters-before")).toBe(true);
    // …and Quoll's `.cm-gutters.cm-gutters-before { border-right-width: 0 }` actually
    // wins and neutralises CM's default 1px separator. Non-vacuous BOTH ways: CM's
    // baseTheme paints a 1px right border here, so a computed 0px proves our rule
    // applied; and if a CM bump dropped `cm-gutters-before`, the double-class selector
    // would under-match and the border would revert to 1px → this assertion goes red.
    expect(getComputedStyle(gutters as HTMLElement).borderRightWidth).toBe("0px");
  });

  // ── Coupling (3): fold/index.ts `.cm-foldGutter { position: relative; left: <rem> }` ──
  // The chevron overlay nudge is applied to CM's `.cm-foldGutter`. CM's default gives
  // that element neither `position: relative` nor a `left` offset, so a computed
  // `position: relative` + a matching `left` proves OUR rule still lands on the
  // rendered element (non-vacuous: a CM rename/restructure drops it to the static
  // default). The expected `left` is read from the SHIPPED rule at runtime — the
  // single source of truth — so the parallel `feat/fold-caret-gap-tighten` branch
  // (which tightens this `left` from 2rem) keeps this test green without an edit here.
  it("(3) the .cm-foldGutter position/left overlay nudge lands on the rendered gutter", async () => {
    view = mountFold();
    await settled();

    // Read the declared rule (source of truth) from the injected CM StyleModule sheet.
    const rule = findFoldGutterRule();
    expect(rule.style.position).toBe("relative");
    const declaredLeft = rule.style.left; // current shipped value, e.g. "2.35rem" — read live, may be retuned
    expect(declaredLeft).toMatch(/^[\d.]+rem$/);
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const expectedLeftPx = parseFloat(declaredLeft) * rootPx;

    const el = view.dom.querySelector<HTMLElement>(".cm-foldGutter");
    expect(el).not.toBeNull();
    const cs = getComputedStyle(el as HTMLElement);
    expect(cs.position).toBe("relative");
    expect(parseFloat(cs.left)).toBeCloseTo(expectedLeftPx, 1);
  });
});

/** The base `.cm-foldGutter` theme rule from the injected CM StyleModule stylesheet
 *  (EditorView.theme scopes it as `.ͼ… .cm-foldGutter`). Matched by the selector
 *  ENDING in `.cm-foldGutter` (excludes the descendant `.cm-foldGutter span` /
 *  `.cm-foldGutter .quoll-fold-marker` rules) AND declaring a `left` (only the base
 *  overlay-nudge rule does). Reading it makes the shipped source the test's single
 *  source of truth for coupling (3)'s value. */
function findFoldGutterRule(): CSSStyleRule {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet — not ours
    }
    for (const rule of Array.from(rules)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText.trim().endsWith(".cm-foldGutter") &&
        rule.style.left !== ""
      ) {
        return rule;
      }
    }
  }
  throw new Error("no base .cm-foldGutter rule (with a declared `left`) found in injected sheets");
}
