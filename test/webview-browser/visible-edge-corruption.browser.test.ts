// UPSTREAM PIN: without recovery, the hidden→visible-while-narrow→widen window
// corrupts CodeMirror's scroll anchor / viewport (scrollTop resets to 0 and/or
// a viewport-sized .cm-gap covers the visible area) — user report 2026-07-12,
// residual of PR #199 (that fix neutralised the minWidth PAINT latch; this is
// the MEASUREMENT corruption in the same window). Deliberately does NOT mount
// quollVisibleEdgeRecovery — it pins the raw upstream behaviour. If a
// @codemirror/view bump turns this test red, upstream may have fixed the
// window — re-evaluate whether the recovery plugin is still needed before
// deleting either (companion suite: visible-edge-recovery.browser.test.ts).
// happy-dom cannot observe any of this (no layout engine) — real browser only.
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureGeometry,
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

describe("visible-edge corruption — upstream pin (no recovery mounted)", () => {
  it("the handoff window corrupts scroll and/or viewport", async () => {
    stubVisibility();
    const m = mount([]);
    view = m.view;
    const before = await pinAndScroll(m.view, m.host);
    expect(before).toBeGreaterThan(1000); // mid-doc for real
    const beforeGeom = captureGeometry(m.view);
    await runHandoffWindow(m.root);
    const after = captureGeometry(m.view);
    // The corruption manifests as a height-oracle desync — the heightmap
    // inflates (scrollHeight balloons) and/or a viewport-sized .cm-gap leaves a
    // blank hole. scrollTop can move EITHER way as it tracks the corrupt
    // heightmap, so scrollHeight inflation is the robust signal (isolated
    // 2026-07-12 — a single-step widen does NOT reproduce; the multi-step ramp
    // in runHandoffWindow does).
    const corrupted =
      after.scrollHeight > beforeGeom.scrollHeight * 1.15 ||
      after.hole > m.view.scrollDOM.clientHeight / 2 ||
      after.scrollTop < before / 2;
    expect(corrupted).toBe(true);
  });
});
