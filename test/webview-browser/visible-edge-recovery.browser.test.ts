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
import { afterEach, describe, expect, it, vi } from "vitest";
import { quollVisibleEdgeRecovery } from "../../src/webview/cm/visible-edge-recovery.js";
import { raf } from "./helpers/frames.js";
import {
  biggestUncoveredHole,
  lineNumberAtViewportTop,
  mount,
  pinAndScroll,
  resetVisibility,
  runHandoffWindow,
  setVisibility,
  stubVisibility,
  until,
} from "./helpers/handoff-window.js";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.getElementById("root")?.remove();
  resetVisibility();
  document.body.style.display = "";
  vi.restoreAllMocks();
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

  // The post-cap LATE-SETTLE RESUME contract: after the quarantine watch caps with
  // still-unsettled geometry, a ResizeObserver on scrollDOM resumes rolling capture
  // when the width settles LATE in the SAME visible session (no second visibility
  // edge). The unit suite pins the state machine by driving an INJECTED ResizeObserver
  // stub (happy-dom has no layout engine); this browser test is the only place the
  // REAL ResizeObserver fires on a REAL width change and drives the resume.
  //
  // Why this does NOT hit the tradeoff the earlier prototype did: it never asserts the
  // handoff's ±2-line restore precision (which a small maxWaitFrames degrades, since
  // the wait caps mid-ramp). The discriminator is the RESUME itself — a scroll made
  // AFTER the late settle is captured and then restored on the next edge. Pre-fix
  // (no late-settle ResizeObserver) the freeze stays parked through the hold below, so
  // the post-settle scroll is dropped and `until()` times out red; the far-apart line
  // comparison (top vs the deep pin) needs no fine precision.
  it("a real ResizeObserver resumes rolling capture on a late geometry settle; a post-settle scroll is captured and restored on the next edge", async () => {
    stubVisibility();
    // Small wait budget so BOTH the visible-edge wait and the quarantine watch cap
    // mid-ramp (2×6 < the 16-frame ramp below) → observeLateSettle() attaches a real
    // ResizeObserver; still ≥ STABLE_FRAMES+1 so the SECOND (clean-width) edge settles
    // precisely. Exposed maxWaitFrames is test-only (see quollVisibleEdgeRecovery).
    const m = mount([quollVisibleEdgeRecovery({ maxWaitFrames: 6 })]);
    view = m.view;
    const deep = await pinAndScroll(m.view, m.host);
    expect(deep).toBeGreaterThan(1000);
    const lineDeep = lineNumberAtViewportTop(m.view); // where the rolling snapshot is armed

    // Hidden → visible while the width RAMPS in 2-frame steps: within a step the width
    // is equal for at most 2 frames and every step is strictly wider, so the
    // consecutive-stable counter never reaches STABLE_FRAMES (3). beginWait caps at
    // ~frame 6 and the quarantine watch at ~frame 12 — both mid-ramp (< 16) — so the
    // snapshot is quarantined and the real ResizeObserver attaches.
    setVisibility("hidden");
    document.body.style.display = "none";
    await raf();
    await raf();
    m.root.style.width = "80px";
    document.body.style.display = "";
    setVisibility("visible");
    for (const w of [120, 200, 300, 400, 480, 560, 620, 680]) {
      m.root.style.width = `${w}px`;
      await raf();
      await raf();
    }
    // Now HOLD the width stable at 680. The last ramp step (and the observer's initial
    // observe() callback) run the bounded settle-check on a now-steady width → it
    // reaches STABLE_FRAMES → the freeze lifts and rolling capture RESUMES, with NO
    // second visibility edge. Poll: scroll to the very top each frame until a capture
    // lands (proves the resume). Pre-fix the freeze is parked here forever → red.
    // Spy installed here (not earlier): scrollSnapshot() is a fresh property
    // lookup on every call (visible-edge-recovery.ts), so this only needs to
    // predate the resumed capture we're asserting on.
    const snap = vi.spyOn(m.view, "scrollSnapshot");
    await until(() => {
      m.view.scrollDOM.scrollTop = 0;
      m.view.scrollDOM.dispatchEvent(new Event("scroll"));
      return snap.mock.calls.length > 0;
    });
    expect(snap).toHaveBeenCalled(); // capture resumed via the real ResizeObserver
    const lineTop = lineNumberAtViewportTop(m.view);
    expect(lineTop).toBeLessThan(lineDeep); // we genuinely moved far from the deep pin

    // Behavioural payoff (why this is a BROWSER test, not just a real-RO unit test):
    // the RESUMED snapshot — the top position captured after the late settle — is what
    // a later hidden→visible edge restores. Width is stable at 680, so this edge settles
    // and restores precisely.
    const midpoint = Math.floor((lineTop + lineDeep) / 2);
    setVisibility("hidden");
    await raf();
    await raf();
    // While FROZEN, shove the scroller back down to the deep position. The snapshot is
    // pinned at the top (frozen → this scroll is not captured), so the restore must
    // actively bring the viewport back up — without this perturbation the viewport is
    // already at the top and the predicate below would pass before restore() even runs
    // (a no-op restore would look identical). Poll for CM to render the deep viewport
    // (rAF-driven measure), which also pins that the perturbation genuinely took effect.
    m.view.scrollDOM.scrollTop = deep;
    await until(() => lineNumberAtViewportTop(m.view) > midpoint); // perturbed: predicate now FALSE
    setVisibility("visible");
    await until(() => lineNumberAtViewportTop(m.view) < midpoint); // restore pulls it back to the top
    expect(lineNumberAtViewportTop(m.view)).toBeLessThan(midpoint);
    expect(biggestUncoveredHole(m.view.scrollDOM)).toBeLessThan(60); // and no blank hole
  });
});
