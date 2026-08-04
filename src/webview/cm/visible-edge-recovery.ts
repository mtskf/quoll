// Visible-edge scroll/viewport recovery. When VS Code hides the webview
// (editor switch, ⌘⌥K context handoff) and re-shows it, CodeMirror's first
// post-visible measure can run while the pinned-outline flex row is MID-REFLOW
// and the editor column transiently narrow. Two things break in that window
// (isolated 2026-07-12, see .claude/plans/2026-07-12-visible-edge-viewport-recovery.md):
//   1. the DOM scroller's scrollTop reads 0 while hidden, so CM's scroll
//      anchor is lost — the document jumps to the top;
//   2. the height oracle refreshes at the degenerate width, desyncing the
//      heightmap/viewport — a viewport-sized .cm-gap covers the visible area
//      (the "all my text disappeared" symptom) until a later scroll-triggered
//      measure heals it.
// This plugin makes the heal deterministic instead of scroll-dependent:
//   - while VISIBLE with live geometry it keeps a ROLLING snapshot from
//     view.scrollSnapshot() (a StateEffect holding a document anchor plus a
//     pixel offset), refreshed on scroll (rAF-coalesced: at most one capture
//     per frame; the hot path is a flag check) and mapped through doc changes
//     in update() — the upstream-documented way to keep a snapshot valid
//     ("You can map the effect to account for changes"). Rolling capture
//     avoids any dependence on the visibilitychange-vs-layout-teardown
//     ordering: the hidden edge only FREEZES the snapshot, it never has to
//     read geometry. The liveness guard also absorbs the browser's clamp-to-0
//     scroll event fired when layout tears down, regardless of event order.
//   - on the VISIBLE edge it waits (rAF loop) until scrollDOM.clientWidth is
//     live and stable for STABLE_FRAMES consecutive frames (capped at
//     maxWaitFrames), then dispatches the snapshot and requestMeasure()s. The
//     splitview that opens the pinned outline ANIMATES the width across several
//     frames after the visible edge, so the wait must also see a STEADY width
//     (not just non-zero) before restoring — restoring mid-ramp would re-anchor
//     to an intermediate degenerate width. At the cap with dead geometry the
//     dispatch is skipped and the snapshot KEPT for the next visible edge.
//   - how the freeze lifts depends on WHY the wait ended:
//       · SETTLED (width stable): lift TWO FRAMES after the restore (thaw()).
//         CM applies the snapshot scroll on its next measure, not synchronously
//         in dispatch, and that programmatic scroll echo must not be re-captured
//         while the heightmap may still be settling. Two frames is enough here
//         because the echo does not move clientWidth.
//       · FRAME CAP with UNSETTLED geometry (width still ramping, or dead): the
//         two-frame thaw is NOT enough — if the ramp keeps going after the thaw,
//         a scroll it fires would hit refreshSnapshot (which guards clientWidth>0
//         but NOT stability) and overwrite the good pre-hide snapshot with one
//         anchored to degenerate mid-ramp geometry, so the recovery poisons its
//         own state under sustained resize + CPU load. Instead we QUARANTINE the
//         snapshot: keep the freeze and WATCH (bounded rAF, never unbounded)
//         until the width is stable for STABLE_FRAMES (thawWhenStable() →
//         runSettleWatch()), then resume capture. If that budget expires with
//         geometry STILL unsettled we do NOT merely park until the next visible
//         edge: geometry can settle just AFTER the budget within the SAME visible
//         session, and a scroll the user then makes would be lost (frozen), so a
//         later edge would restore a stale anchor. So on expiry we attach a
//         ResizeObserver to scrollDOM (observeLateSettle()) and let any LATE
//         resize restart the same bounded settle-check — event-driven, so a
//         dead/never-firing/zero-width geometry polls NOTHING while idle (the
//         "no unbounded rAF" invariant). We KEEP, not invalidate, the snapshot on
//         every give-up path, so a dead-then-recover blip still restores the
//         pre-hide position. The observer's callback is state-guarded (a queued
//         callback that fires after teardown/thaw is inert), and the observer
//         lives ONLY during this post-expiry window: a hidden edge (cancelWait +
//         stopObservingLateSettle) drops the watch and keeps the freeze for the
//         next edge; the next visible edge (beginWait) and destroy() also
//         disconnect it — beginWait supersedes, destroy tears the instance down.
// Note ScrollTarget.clip() clamps to the doc length at application time, so
// even a stale snapshot cannot throw — mapping is about position correctness.
// Pure view chrome: no document mutation, no write-lock, no protocol message.
// The companion PAINT-side fix for the same window is the `!important`
// flex-basis in cm/theme.ts (PR #199) — do not remove either without the
// other's regression suite in hand (visible-edge-corruption.browser.test.ts /
// visible-edge-recovery.browser.test.ts / outline-sidebar-layout.browser.test.ts).

import type { Extension } from "@codemirror/state";
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** The effect type scrollSnapshot() returns (StateEffect<ScrollTarget>).
 *  ScrollTarget is declared but NOT exported by @codemirror/view, so derive
 *  the type from the method instead of importing it. */
type ScrollSnapshotEffect = ReturnType<EditorView["scrollSnapshot"]>;

/** Give up waiting for live-and-stable geometry after this many frames
 *  (~1 s at 60 Hz). The snapshot is kept, so a later visible edge retries. */
const DEFAULT_MAX_WAIT_FRAMES = 60;

/** Consecutive equal, non-zero clientWidth frames that count as "settled".
 *  The pinned-outline splitview animates the width open over several frames
 *  after the webview becomes visible, so the restore must wait for the width
 *  to stop changing (not merely be non-zero) or it re-anchors mid-ramp. */
const STABLE_FRAMES = 3;

/** Frames the freeze outlives the restore dispatch (see header). Overridable
 *  for tests only — the thaw branches are frame-races at the default. */
const DEFAULT_THAW_FRAMES = 2;

/** Advance the consecutive-stable-frame counter for one width sample: reset to
 *  0 on a zero or changed width, otherwise increment. Shared by the visible-edge
 *  wait (beginWait) and the cap-path quarantine (thawWhenStable) so the two
 *  decision points can never silently disagree on what "settled" means. */
function nextStableCount(width: number, lastWidth: number, stable: number): number {
  return width > 0 && width === lastWidth ? stable + 1 : 0;
}

class VisibleEdgeRecovery implements PluginValue {
  /** Last good scroll snapshot (rolling; mapped through doc changes). */
  private snapshot: ScrollSnapshotEffect | null = null;
  /** Set on the hidden edge; suppresses rolling refresh until thawFrames
   *  after the visible-edge restore, so degenerate mid-teardown/mid-reflow
   *  scroll events — including the restore's own scroll echo — can never
   *  overwrite the good snapshot. */
  private frozen = false;
  /** Active rAF id of the wait/thaw chain; 0 when idle. Shared slot on
   *  purpose: cancelWait() kills whichever phase is in flight. */
  private waitFrame = 0;
  /** rAF-coalescing flag for the rolling capture. */
  private captureQueued = false;
  /** Guards the two capture/watch entry points against view.destroy() racing
   *  them: the scroll handler's refreshSnapshot() and the late-settle
   *  ResizeObserver callback (observeLateSettle). The latter is the genuine
   *  async race — the browser can deliver a queued RO callback after teardown;
   *  refreshSnapshot() runs synchronously off the scroll event, so its check is
   *  belt-and-suspenders. Either way, a post-destroy invocation is inert. */
  private destroyed = false;
  /** Connected only during the post-expiry late-settle watch (observeLateSettle);
   *  null whenever we are not observing. */
  private resizeObserver: ResizeObserver | null = null;
  private readonly doc: Document;

  private readonly onScroll = (): void => {
    // Coalesce to one capture per frame (the hot path is a flag check), but take
    // the snapshot SYNCHRONOUSLY here rather than inside the rAF. A scroll
    // immediately followed by a same-frame hide (⌘⌥K handoff / tab switch) would
    // otherwise queue a capture that then runs while frozen and is discarded,
    // restoring a one-frame-stale position. refreshSnapshot already gates on
    // !frozen + visible + clientWidth>0, so the synchronous call stays
    // geometry-safe and never reads the hidden edge; the rAF only clears the
    // per-frame coalescing flag.
    if (this.captureQueued) {
      return;
    }
    this.captureQueued = true;
    this.refreshSnapshot();
    requestAnimationFrame(() => {
      this.captureQueued = false;
    });
  };

  private readonly onVisibilityChange = (): void => {
    if (this.doc.visibilityState === "hidden") {
      this.frozen = true;
      this.cancelWait(); // also cancels an in-flight thaw → freeze persists
      this.stopObservingLateSettle(); // a resize while hidden must not thaw us
      return;
    }
    this.beginWait();
  };

  constructor(
    private readonly view: EditorView,
    private readonly maxWaitFrames: number,
    private readonly thawFrames: number
  ) {
    this.doc = view.dom.ownerDocument;
    // passive: the handler only sets a flag / stores an effect object.
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.doc.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /** Keep the snapshot valid across doc edits (external-edit reseed while
   *  hidden included): map its document anchor through the changes, exactly as
   *  the scrollSnapshot() docs prescribe. StateEffect.map's TYPE admits
   *  undefined (an effect may be dropped by mapping); this effect's mapper
   *  (ScrollTarget.map) never actually drops, so `?? null` is type-driven. */
  update(u: ViewUpdate): void {
    if (u.docChanged && this.snapshot) {
      this.snapshot = this.snapshot.map(u.changes) ?? null;
    }
  }

  /** Rolling capture: only while unfrozen, visible, and with live geometry —
   *  the guards (not event ordering) are what keep teardown junk out. */
  private refreshSnapshot(): void {
    if (this.destroyed || this.frozen || this.doc.visibilityState !== "visible") {
      return;
    }
    if (this.view.scrollDOM.clientWidth <= 0) {
      return;
    }
    this.snapshot = this.view.scrollSnapshot();
  }

  /** Visible edge: wait until clientWidth is non-zero and unchanged for
   *  STABLE_FRAMES consecutive frames (the splitview reflow has settled),
   *  capped at maxWaitFrames, then restore. */
  private beginWait(): void {
    this.cancelWait();
    this.stopObservingLateSettle(); // a prior cycle's late-settle watch is superseded
    let frames = 0;
    let lastWidth = -1;
    let stable = 0;
    const tick = (): void => {
      this.waitFrame = 0;
      frames += 1;
      const width = this.view.scrollDOM.clientWidth;
      stable = nextStableCount(width, lastWidth, stable);
      lastWidth = width;
      const settled = stable >= STABLE_FRAMES;
      if (settled || frames >= this.maxWaitFrames) {
        this.restore(width > 0, settled);
        return;
      }
      this.waitFrame = requestAnimationFrame(tick);
    };
    this.waitFrame = requestAnimationFrame(tick);
  }

  private cancelWait(): void {
    if (this.waitFrame !== 0) {
      cancelAnimationFrame(this.waitFrame);
      this.waitFrame = 0;
    }
  }

  /** Disconnect the late-settle ResizeObserver (idempotent). Kept SEPARATE from
   *  cancelWait() on purpose: cancelWait() runs at the START of every settle
   *  watch, and disconnecting there would kill the very observer that drives the
   *  resize-triggered recheck. */
  private stopObservingLateSettle(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  /** Dispatch the snapshot (when geometry is live) — restoring the correct
   *  document line to the viewport top — and force a measure at the CURRENT
   *  geometry (settled, or — on the cap paths below — not; requestMeasure() is
   *  unconditional), which collapses the stale viewport-sized .cm-gap so content
   *  renders (the "text disappeared" symptom). NOTE: requestMeasure() only
   *  re-measures the VIEWPORT; the height oracle's inflated OFF-SCREEN estimate
   *  is not rebuilt here (CM 6.43.0 exposes no full-heightmap-rebuild call short
   *  of view.setState(view.state), a heavy redraw/reinit we deliberately avoid —
   *  verified against @codemirror/view source, 2026-07-12). scrollHeight can
   *  therefore stay transiently inflated and heals lazily on the next scroll —
   *  CM's own design, and the pre-existing "scrolling fixes it" the user saw.
   *  The user-visible win: content is at the right place immediately, not blank.
   *  Skipping with dead geometry KEEPS the snapshot so the next visible edge can
   *  retry. Ends by scheduling the thaw appropriate to WHY we stopped waiting:
   *  `settled` (geometry stable) uses the short fixed thaw that just outlives
   *  the restore's own scroll echo; a frame-cap stop with UNSETTLED geometry
   *  (live-but-still-ramping OR dead) instead quarantines the snapshot via
   *  thawWhenStable() — see header + that method. */
  private restore(live: boolean, settled: boolean): void {
    if (live && this.snapshot) {
      // A scroll effect is pure view state: no doc change, no undo entry, no
      // edit-sync post (docChanged=false on the resulting update). Dispatch
      // does not consume the snapshot; the next unfrozen scroll refreshes it.
      this.view.dispatch({ effects: this.snapshot });
      if (QUOLL_PERF) {
        console.debug("[quoll] visible-edge-recovery: scroll restored");
      }
    } else if (QUOLL_PERF) {
      console.debug(
        `[quoll] visible-edge-recovery: restore skipped (${
          this.snapshot ? "geometry never settled" : "no snapshot"
        })`
      );
    }
    this.view.requestMeasure();
    if (settled) {
      this.thaw();
    } else {
      this.thawWhenStable();
    }
  }

  /** Lift the freeze thawFrames after a SETTLED restore. Rides the same
   *  waitFrame slot as beginWait, so a hidden edge mid-thaw cancels it and the
   *  freeze (and the kept snapshot) persists for the next visible edge. Safe
   *  because geometry is already stable: the only scroll it must outlive is the
   *  restore's own programmatic echo, which does not move clientWidth. */
  private thaw(): void {
    let frames = 0;
    const tick = (): void => {
      this.waitFrame = 0;
      frames += 1;
      if (frames >= this.thawFrames) {
        this.frozen = false;
        return;
      }
      this.waitFrame = requestAnimationFrame(tick);
    };
    this.waitFrame = requestAnimationFrame(tick);
  }

  /** Cap-path quarantine. We reached restore at the frame cap with the width
   *  still ramping (or dead), dispatched the heal, and must NOT resume rolling
   *  capture yet: refreshSnapshot() guards on clientWidth>0 but not on stability,
   *  so a scroll fired by the continuing ramp would overwrite the good pre-hide
   *  snapshot with one anchored to degenerate mid-ramp geometry — the recovery
   *  poisoning its own state under sustained resize + CPU load. So keep frozen
   *  (and the good snapshot) and watch until the width is live and stable for
   *  STABLE_FRAMES, then thaw. BOUNDED by maxWaitFrames — never an unbounded rAF.
   *  On expiry we do NOT merely park until the next visible edge: geometry can
   *  settle just AFTER the budget within the SAME visible session, and a scroll
   *  the user then makes would be dropped (frozen), so a later edge would restore
   *  a stale anchor. Instead observeLateSettle() attaches a ResizeObserver and
   *  lets any late resize restart this SAME bounded watch — event-driven, so a
   *  dead/never-firing/zero-width geometry polls nothing while idle. We KEEP, not
   *  invalidate, the snapshot on every give-up path: the common case is a webview
   *  that was dead/narrow for the whole budget and then recovers, where restoring
   *  the pre-hide position is exactly the win; the residual (user scrolled
   *  somewhere new during a never-settling window and a later edge restores the
   *  old spot) is rare and clip-safe. */
  private thawWhenStable(): void {
    this.runSettleWatch(() => this.observeLateSettle());
  }

  /** Bounded rAF watch for a settled width, shared by the initial cap-path
   *  quarantine (thawWhenStable) and each resize-triggered recheck
   *  (observeLateSettle). On STABLE_FRAMES consecutive live-and-equal widths it
   *  lifts the freeze and stops observing; at the frame cap (never an unbounded
   *  rAF) it runs `onExpiry` and returns, leaving the freeze — and the kept
   *  snapshot — in place. Rides the shared waitFrame slot: cancelWait() (hidden
   *  edge / next visible edge / destroy) stops the rAF; a hidden edge keeps the
   *  freeze for the next edge, destroy() tears the instance down. */
  private runSettleWatch(onExpiry: () => void): void {
    this.cancelWait();
    let frames = 0;
    let lastWidth = -1;
    let stable = 0;
    const tick = (): void => {
      this.waitFrame = 0;
      frames += 1;
      const width = this.view.scrollDOM.clientWidth;
      stable = nextStableCount(width, lastWidth, stable);
      lastWidth = width;
      if (stable >= STABLE_FRAMES) {
        this.frozen = false; // geometry finally steady: safe to roll again
        this.stopObservingLateSettle();
        return;
      }
      if (frames >= this.maxWaitFrames) {
        onExpiry();
        return;
      }
      this.waitFrame = requestAnimationFrame(tick);
    };
    this.waitFrame = requestAnimationFrame(tick);
  }

  /** Post-expiry event-driven resume: watch scrollDOM for a LATE geometry settle
   *  after the quarantine budget ran out. Idempotent; the `typeof` guard degrades
   *  gracefully on layout-free / older-webview hosts (there the freeze stays
   *  parked until the next visible edge — the pre-change behaviour). Each resize
   *  restarts the bounded settle-check (runSettleWatch); if it caps again we stay
   *  observing for the next resize (no polling while idle). runSettleWatch lifts
   *  the freeze and disconnects us once the width is stable. ResizeObserver
   *  delivers one initial callback on observe(), which just runs an immediate
   *  settle-check — covering a width that settled exactly at the budget edge.
   *  The callback is STATE-GUARDED: disconnect() does not retract an
   *  already-queued browser callback, so a stale one (fired after a hidden edge /
   *  destroy() / successful thaw) must not start a new watch. Capture `observer`
   *  in the closure and bail unless it is still the live observer, the instance
   *  is alive, we are visible, and still frozen (mirrors the `disposed` guard in
   *  cm/decorations/prose-space-metric.ts). */
  private observeLateSettle(): void {
    // Already observing, or the invariant "observer non-null only while frozen"
    // would be violated — bail. Asserting `frozen` here makes that invariant
    // self-enforcing at the attachment site rather than relying solely on the
    // callback's post-hoc `!frozen` bail + call-order discipline.
    if (this.resizeObserver || !this.frozen) {
      return;
    }
    if (typeof ResizeObserver === "undefined") {
      // Layout-free / older-webview host: no late-settle watch is possible, so
      // the freeze stays parked until the next visible edge. Trace it like the
      // file's other consequential skip branches (see restore()) so a silently
      // parked session is diagnosable in the perf build.
      if (QUOLL_PERF) {
        console.debug(
          "[quoll] visible-edge-recovery: late-settle watch unavailable (no ResizeObserver) — freeze parked until the next visible edge"
        );
      }
      return;
    }
    const observer = new ResizeObserver(() => {
      if (
        this.destroyed ||
        this.resizeObserver !== observer ||
        this.doc.visibilityState !== "visible" ||
        !this.frozen
      ) {
        return;
      }
      this.runSettleWatch(() => {});
    });
    this.resizeObserver = observer;
    observer.observe(this.view.scrollDOM);
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelWait();
    this.stopObservingLateSettle();
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.doc.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
}

/** Visible-edge scroll/viewport recovery extension (see the header comment).
 *  `maxWaitFrames` / `thawFrames` are exposed for tests only — production
 *  uses the defaults. */
export function quollVisibleEdgeRecovery(opts?: {
  maxWaitFrames?: number;
  thawFrames?: number;
}): Extension {
  const maxWaitFrames = opts?.maxWaitFrames ?? DEFAULT_MAX_WAIT_FRAMES;
  const thawFrames = opts?.thawFrames ?? DEFAULT_THAW_FRAMES;
  return ViewPlugin.define((view) => new VisibleEdgeRecovery(view, maxWaitFrames, thawFrames));
}
