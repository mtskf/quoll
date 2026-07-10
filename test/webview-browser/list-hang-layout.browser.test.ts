import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { proseSpaceMetric } from "../../src/webview/cm/decorations/prose-space-metric.js";
import { listHangIndent } from "../../src/webview/cm/list/list-hang-indent.js";
import { quollCmLinePaddingTheme } from "../../src/webview/cm/theme.js";

// The `.cm-line` start-padding token. Task 1 shipped this as the EXISTING
// `--quoll-column-inset-left` (styles.css :root, mirrored by the fenced-code /
// blockquote panels), NOT a new `--quoll-cm-line-pad-start` — the pixel gate
// tracks the real shipped token. `CM_LINE_START_PADDING` (cm/theme.ts) is
// `var(--quoll-column-inset-left, 6px)`; this mount does NOT load styles.css, so
// the token is undeclared and the `6px` fallback is what the line resolves to —
// which equals the production :root value, so the default-6px contract holds.
const PADDING_TOKEN = "--quoll-column-inset-left";

// The `- ` marker is sized by list-geometry's GLYPH blend
// `calc((1ch + var(--quoll-prose-space)) / 2)`. That blend is font-ADAPTIVE, not
// font-proof (module header): in a PROPORTIONAL font the `0`-advance (`1ch`) and
// the real dash advance diverge, leaving a font-specific residual (~5px for
// headless chromium's default sans-serif) that is layout noise, not a
// regression signal. In a MONOSPACE font `1ch == a space == the dash advance`,
// so the blend degrades to EXACT (header line ~225) and the hang aligns to
// sub-pixel. The mount therefore forces monospace so this gate is DETERMINISTIC
// across CI runners: a real break (padding token dropped, geometry off) shifts
// alignment by a whole marker column (>=6px) and blows past this tolerance,
// while correct code stays well inside it. Kept per-target (Codex C85): only the
// bullet-glyph case uses it; the ownership + nesting checks are exact/ordinal.
const BULLET_TOLERANCE_PX = 2;

/** Resolve after CM's layout has quiesced. proseSpaceMetric writes
 *  --quoll-prose-space on its first measure, then queues (via queueMicrotask)
 *  exactly ONE follow-up view.requestMeasure to rebuild the height map against
 *  the new padding — and that re-measure CONVERGES (no further measures schedule;
 *  prose-space-metric.ts). Because the settling is BOUNDED, awaiting a small
 *  fixed number of frames drains every pending measure regardless of
 *  microtask/rAF interleaving (more robust than a 2-frame wait whose ordering vs
 *  the microtask-scheduled re-measure is not guaranteed — Codex C84), after which
 *  coordsAtPos()/getComputedStyle() read a settled height map (Codex C93). */
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
  document.body.querySelectorAll(".cm-mount-probe").forEach((n) => {
    n.remove();
  });
});

function mount(doc: string, extra: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-mount-probe";
  parent.style.width = "300px";
  // Monospace so the marker-glyph blend degrades to EXACT (see BULLET_TOLERANCE_PX):
  // `1ch == a space == the dash advance`, making the hang deterministic across CI
  // runners instead of carrying a font-specific residual. `monospace` always resolves.
  parent.style.fontFamily = "monospace";
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      // Production order: proseSpaceMetric BEFORE listHangIndent (mirrors editor.ts).
      extensions: [
        markdown({ base: markdownLanguage }),
        proseSpaceMetric,
        listHangIndent,
        quollCmLinePaddingTheme,
        EditorView.lineWrapping,
        ...extra,
      ],
    }),
    parent,
  });
}

describe("list hang-indent — real-pixel layout (browser gate)", () => {
  it(`(b) the .cm-line start padding is owned by ${PADDING_TOKEN}`, async () => {
    // A PLAIN paragraph (no bullet) carries no list-hang decoration, so its
    // `.cm-line` padding-left is the theme rule alone — the surface under
    // contract. Non-vacuous cascade proof: CM's baseTheme also sets `.cm-line`
    // padding-left to 6px, so the default case can't distinguish our theme from
    // CM's. Drive the token to a DISTINCTIVE 11px on .cm-content (custom
    // properties inherit to .cm-line); the computed line padding must follow it.
    // Fails if the padding were a hard-coded 6px or if CM's baseTheme won.
    view = mount("paragraph", [EditorView.theme({ ".cm-content": { [PADDING_TOKEN]: "11px" } })]);
    await settled();
    const line = view.contentDOM.querySelector(".cm-line") as HTMLElement;
    expect(getComputedStyle(line).paddingLeft).toBe("11px");
  });

  it("(b) default base is 6px == the decoration hang base", async () => {
    // Plain paragraph again (isolates the theme rule from the hang decoration's
    // inline padding-inline-start). No styles.css in this mount, so the token is
    // undeclared and the line resolves via the `var(…, 6px)` fallback — the same
    // 6px the decoration's CM_LINE_START_PADDING constant uses as its hang base,
    // kept in lockstep.
    view = mount("paragraph");
    await settled();
    const line = view.contentDOM.querySelector(".cm-line") as HTMLElement;
    expect(getComputedStyle(line).paddingLeft).toBe("6px");
  });

  it("(a) a soft-wrapped bullet's continuation hangs under its first-row content", async () => {
    view = mount("- This is a fairly long bullet whose text must wrap onto a second visual row");
    await settled();
    const line = view.contentDOM.querySelector(".cm-line") as HTMLElement;
    const lineRect = line.getBoundingClientRect();
    // Prove it actually wrapped MECHANICALLY (not via lineHeight, which can be
    // "normal" → NaN — Codex C88): a char near the end sits strictly BELOW the
    // first row (its top >= the first char's bottom).
    const firstRow = view.coordsAtPos(2); // after `- `
    const lastRow = view.coordsAtPos(view.state.doc.line(1).to - 1);
    expect(firstRow).not.toBeNull();
    expect(lastRow).not.toBeNull();
    expect((lastRow as { top: number }).top).toBeGreaterThanOrEqual(
      (firstRow as { bottom: number }).bottom - 0.5
    );
    // Continuation rows begin at the line content-box left = border-left + padding-inline-start.
    const padInlineStart = parseFloat(getComputedStyle(line).paddingInlineStart);
    const continuationLeft = lineRect.left + padInlineStart;
    expect(Math.abs((firstRow as { left: number }).left - continuationLeft)).toBeLessThan(
      BULLET_TOLERANCE_PX
    );
  });

  it("(a) a nested child renders further right than its parent (visible nesting)", async () => {
    view = mount("- parent\n  - child");
    await settled();
    const parentX = view.coordsAtPos(2)?.left; // after `- ` on line 1
    const childLine = view.state.doc.line(2);
    const childX = view.coordsAtPos(childLine.from + 4)?.left; // after `  - ` on line 2
    expect(parentX).toBeTypeOf("number");
    expect(childX).toBeTypeOf("number");
    expect(childX as number).toBeGreaterThan(parentX as number);
  });
});
