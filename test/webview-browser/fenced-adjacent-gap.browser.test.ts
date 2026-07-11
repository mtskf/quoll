// Real-browser gate for the NEW behaviour this PR ships: two DIRECTLY-adjacent fenced
// code blocks (no blank source line between them) render a SINGLE ~8px external gap, not
// a stacked ~16px. Before the decoration-driven refactor the boundary was decided by
// rendered-sibling CSS (`.quoll-fenced-code-close` gap + `.quoll-fenced-code-open` gap),
// and because the two panels are separated only by zero-height concealed fence rows,
// BOTH gaps fired — an independent 8px bottom border on block1 AND an independent 8px top
// border on block2 that do not collapse, so the seam showed ~16px.
//
// The builder now emits a document-model `.quoll-fenced-code-outer-open` /
// `-outer-close` on each panel's TRUE outer boundary and suppresses the SECOND
// adjacent block's `-outer-open`, so exactly one 8px gap remains. This is a real-pixel
// fact happy-dom cannot check (no layout; drops var()/calc() — memories
// quoll-happy-dom-no-layout-cssom-drops-calc / quoll-webview-css-bug-real-browser-harness),
// so it lives here. Measured as the vertical distance between the two panels' PAINTED
// fills (each panel clips its fill to the padding box, so the gap is exactly the sum of
// the transparent border(s) between them): single gap ⇒ ~8px, the pre-fix stacked bug
// ⇒ ~16px. Checked in all three caret states (both blocks concealed; block1 revealed;
// block2 revealed) — the conceal migration must never resurrect the second gap.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { blockStyle } from "../../src/webview/cm/decorations/block-style.js";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { fencedCodeCollapseField } from "../../src/webview/cm/fenced-code/fenced-code-collapse.js";
import { quollBlockStyleTheme, quollCmLinePaddingTheme } from "../../src/webview/cm/theme.js";

// Two directly-adjacent single-body fenced blocks, then a blank + paragraph so the caret
// can park OFF both. block2's opening fence is doc line 4 — the split point between the
// two panels used to attribute each rendered fenced line to block1 vs block2.
//   L1 ```[0,3] L2 a[4,5] L3 ```[6,9] L4 ```[10,13] L5 b[14,15] L6 ```[16,19] L7 ""[20] L8 para
const DOC = "```\na\n```\n```\nb\n```\n\npara";
const BLOCK2_OPEN_LINE = 4;

/** Drain CM's bounded measure queue (4-frame idiom shared with the sibling browser
 *  suites) so getBoundingClientRect / getComputedStyle read a settled layout. */
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
  for (const n of document.body.querySelectorAll(".cm-adjacent-fenced-probe")) {
    n.remove();
  }
});

function mount(caret: number): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-adjacent-fenced-probe";
  parent.style.width = "400px";
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: EditorSelection.single(caret),
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        blockStyle,
        fencedCodeCollapseField,
        // The panel fill + rounded edges + external gap border + zero-height hidden fence
        // rows all live in these two themes (blockStyleThemeSpec); mount them so the gap
        // actually renders. --quoll-block-gap-y is absent (styles.css not loaded) → its
        // 8px fallback holds, the single-gap target.
        quollCmLinePaddingTheme,
        quollBlockStyleTheme,
      ],
    }),
    parent,
  });
}

/** The vertical distance between the two panels' PAINTED fills. Each visible fenced line
 *  carries the base `.quoll-fenced-code` class and clips its fill to the padding box, so
 *  the fill edge = border-box edge ∓ the transparent gap border. Split the visible fenced
 *  lines by document position into block1 (< block2's open fence) and block2 (≥ it); the
 *  gap is block2's top-most fill edge minus block1's bottom-most. Concealed fence rows
 *  carry only `.quoll-fenced-code-fence-hidden` (no base class) and are excluded. */
function paintedFillGap(v: EditorView): number {
  const splitPos = v.state.doc.line(BLOCK2_OPEN_LINE).from;
  const fenced = [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].filter((el) =>
    el.classList.contains("quoll-fenced-code")
  );
  expect(fenced.length, "both panels must render at least one visible body line").toBeGreaterThan(
    1
  );
  let block1FillBottom = Number.NEGATIVE_INFINITY;
  let block2FillTop = Number.POSITIVE_INFINITY;
  for (const el of fenced) {
    const pos = v.posAtDOM(el);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const fillBottom = r.bottom - Number.parseFloat(cs.borderBottomWidth || "0");
    const fillTop = r.top + Number.parseFloat(cs.borderTopWidth || "0");
    if (pos < splitPos) {
      block1FillBottom = Math.max(block1FillBottom, fillBottom);
    } else {
      block2FillTop = Math.min(block2FillTop, fillTop);
    }
  }
  return block2FillTop - block1FillBottom;
}

describe("adjacent fenced blocks — single external gap (real-pixel browser gate)", () => {
  // One panel-gap token is ~8px; the pre-fix stacked bug is ~16px. A window of (4, 12)
  // accepts the single gap with sub-pixel slack while firmly rejecting the doubled gap.
  const SINGLE_GAP_MIN = 4;
  const SINGLE_GAP_MAX = 12;

  it("caret OUTSIDE both blocks: the seam is a single ~8px gap, not stacked ~16px", async () => {
    view = mount(DOC.indexOf("para") + 1);
    await settled();
    // Exactly ONE `-outer-open` reaches the DOM (block1's; block2 yields its own) — the
    // document-model contract that produces the single gap, observed in a real render.
    expect(view.contentDOM.querySelectorAll(".quoll-fenced-code-outer-open").length).toBe(1);
    const gap = paintedFillGap(view);
    expect(gap).toBeGreaterThan(SINGLE_GAP_MIN);
    expect(gap).toBeLessThan(SINGLE_GAP_MAX);
  });

  it("caret INSIDE block1 (fences revealed): still a single gap at the seam", async () => {
    view = mount(DOC.indexOf("a")); // caret on block1's body
    await settled();
    const gap = paintedFillGap(view);
    expect(gap).toBeGreaterThan(SINGLE_GAP_MIN);
    expect(gap).toBeLessThan(SINGLE_GAP_MAX);
  });

  it("caret INSIDE block2 (fences revealed): still a single gap at the seam", async () => {
    view = mount(DOC.indexOf("b")); // caret on block2's body
    await settled();
    const gap = paintedFillGap(view);
    expect(gap).toBeGreaterThan(SINGLE_GAP_MIN);
    expect(gap).toBeLessThan(SINGLE_GAP_MAX);
  });
});
