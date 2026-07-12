// RECOVERY CONTRACT: with quollVisibleEdgeRecovery mounted, the scroll position
// and the rendered viewport survive the hidden→visible-while-narrow→widen
// window that corrupts a bare editor (companion pin:
// visible-edge-corruption.browser.test.ts — keep both suites in sync on the
// window sequence via helpers/handoff-window.ts). Three contracts:
//   1. the viewport-top document line + rendered viewport survive the handoff;
//   2. the snapshot MAPS through doc changes made while hidden (prepend test —
//      a clip()-only implementation would fail the exact line-shift assertion);
//   3. a shrink-replace while hidden neither throws nor blanks (clip() bound).
//
// CONTRACT NOTE (verified against @codemirror/view 6.43.0 source + two Codex
// consults, 2026-07-12): the fix restores the correct DOCUMENT LINE to the
// viewport top and forces a viewport measure so content renders (no blank
// .cm-gap). It does NOT collapse the height-oracle's inflated off-screen
// estimate — CM 6.43.0 has no public full-heightmap-rebuild call (requestMeasure
// only measures the viewport; off-screen cached heights heal lazily on the next
// scroll, which is CM's own design). So these tests assert the LINE the user
// sees and the absence of a blank hole, NOT absolute scrollTop/scrollHeight —
// those stay transiently inflated by design and self-heal on scroll.
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollVisibleEdgeRecovery } from "../../src/webview/cm/visible-edge-recovery.js";
import {
  biggestUncoveredHole,
  lineNumberAtViewportTop,
  mount,
  pinAndScroll,
  resetVisibility,
  runHandoffWindow,
  stubVisibility,
} from "./helpers/handoff-window.js";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.getElementById("root")?.remove();
  resetVisibility();
  document.body.style.display = "";
});

describe("visible-edge recovery — real-chromium contract", () => {
  it("the viewport-top line and rendered viewport survive the handoff window", async () => {
    stubVisibility();
    const m = mount([quollVisibleEdgeRecovery()]);
    view = m.view;
    const before = await pinAndScroll(m.view, m.host);
    expect(before).toBeGreaterThan(1000);
    const lineBefore = lineNumberAtViewportTop(m.view);
    await runHandoffWindow(m.root);
    const scroller = m.view.scrollDOM;
    // The user is still where they were: the same document line sits at the
    // viewport top. This is the anchor-restore contract (robust to the
    // height-oracle's lazily-healing scrollHeight inflation, which absolute
    // scrollTop is NOT — see the CONTRACT NOTE above). Without the plugin the
    // corrupt scroll lands the user on a different line (non-vacuity: Step 5).
    expect(Math.abs(lineNumberAtViewportTop(m.view) - lineBefore)).toBeLessThanOrEqual(2);
    // Viewport rendered: no viewport-scale blank hole (the "text disappeared"
    // symptom). requestMeasure() collapses the viewport-covering .cm-gap.
    expect(biggestUncoveredHole(scroller)).toBeLessThan(60);
  });

  it("a prepend while hidden MAPS the snapshot (viewport-top line shifts by exactly the inserted lines)", async () => {
    stubVisibility();
    const m = mount([quollVisibleEdgeRecovery()]);
    view = m.view;
    await pinAndScroll(m.view, m.host);
    const lineBefore = lineNumberAtViewportTop(m.view);
    const INSERTED_LINES = 30;
    await runHandoffWindow(m.root, () => {
      // External edit while hidden, entirely BEFORE the anchor: an unmapped
      // (clip-only) snapshot would restore to the ORIGINAL line number; the
      // mapped snapshot restores to lineBefore + INSERTED_LINES.
      m.view.dispatch({
        changes: { from: 0, insert: "prepended\n".repeat(INSERTED_LINES) },
      });
    });
    const lineAfter = lineNumberAtViewportTop(m.view);
    expect(Math.abs(lineAfter - (lineBefore + INSERTED_LINES))).toBeLessThanOrEqual(1);
    expect(biggestUncoveredHole(m.view.scrollDOM)).toBeLessThan(60);
  });

  it("a shrink-replace while hidden neither throws nor blanks (clip bound)", async () => {
    stubVisibility();
    const m = mount([quollVisibleEdgeRecovery()]);
    view = m.view;
    await pinAndScroll(m.view, m.host);
    await runHandoffWindow(m.root, () => {
      // Much shorter but still viewport-filling (biggestUncoveredHole would
      // false-positive on a 3-line doc that legitimately leaves the viewport
      // empty). The snapshot maps through the whole-doc replace; clip() bounds
      // whatever remains, so the restore must neither throw nor blank.
      m.view.dispatch({
        changes: {
          from: 0,
          to: m.view.state.doc.length,
          insert: `# Replaced\n\n${"replacement line\n".repeat(200)}`,
        },
      });
    });
    expect(biggestUncoveredHole(m.view.scrollDOM)).toBeLessThan(60);
  });
});
