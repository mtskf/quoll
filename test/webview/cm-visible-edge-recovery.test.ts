// @vitest-environment happy-dom

// Lifecycle + capture-guard pins for quollVisibleEdgeRecovery. happy-dom has no
// layout engine, so clientWidth is stubbed per-instance to drive the liveness
// guard both ways. The behavioural scroll/viewport contract is pinned in
// test/webview-browser/visible-edge-recovery.browser.test.ts (real Chromium).
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quollVisibleEdgeRecovery } from "../../src/webview/cm/visible-edge-recovery.js";

let view: EditorView | undefined;
let visState: DocumentVisibilityState = "visible";
let width = 0;
/** When true, clientWidth returns a fresh value on every read, so the wait
 *  loop's `width === lastWidth` stability check can never accumulate — it
 *  simulates the pinned-outline splitview width-ramp that never settles within
 *  the frame budget (the cap-path scenario). */
let widthRamping = false;
let widthReads = 0;

// Capture the late-settle ResizeObserver so the test can fire its callback
// deterministically (happy-dom has no layout engine, so a real RO never fires).
// CM's EditorView also constructs a ResizeObserver on the scroller's ancestors,
// so record only observers that actually observe our scrollDOM.
type ROEntry = { cb: ResizeObserverCallback; targets: Element[] };
let roEntries: ROEntry[] = [];
const realResizeObserver = globalThis.ResizeObserver;
class StubResizeObserver {
  private readonly entry: ROEntry;
  constructor(cb: ResizeObserverCallback) {
    this.entry = { cb, targets: [] };
    roEntries.push(this.entry);
  }
  observe(el: Element): void {
    this.entry.targets.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.entry.targets = [];
  }
}

/** The RO the recovery attached to scrollDOM (last one observing it), or
 *  undefined if none is currently observing. */
function lateSettleObserver(v: EditorView): ROEntry | undefined {
  return [...roEntries].reverse().find((e) => e.targets.includes(v.scrollDOM));
}

/** Drop CM's own baseline ResizeObserver(s) from the log. CM's EditorView
 *  observes scrollDOM too and stays connected, so without this lateSettleObserver
 *  would match CM's observer — both before the recovery attaches (skewing the
 *  no-poll probe) and after it disconnects (never reading undefined). Call after
 *  arming + a couple frames (CM's RO is created by then), before the hide/show. */
function resetObserverLog(): void {
  roEntries = [];
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  delete (document as { visibilityState?: unknown }).visibilityState;
  widthRamping = false;
  widthReads = 0;
  globalThis.ResizeObserver = realResizeObserver;
  roEntries = [];
  vi.restoreAllMocks();
});

function stubVisibility(): void {
  visState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visState,
  });
}

function setVisibility(state: DocumentVisibilityState): void {
  visState = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

function mount(maxWaitFrames: number, thawFrames = 2): EditorView {
  // Install the stub BEFORE constructing the view so the recovery's RO is the
  // stub. CM's own DOMObserver ALSO constructs a ResizeObserver that observes
  // scrollDOM directly (@codemirror/view's resizeScroll) and never disconnects
  // it for the life of the view — so tests that inspect the RO log must call
  // resetObserverLog() after mount to drop that entry, or lateSettleObserver()
  // can match CM's own observer instead of (or after) the recovery's.
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
  width = 500;
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "# One\n\ntwo\n",
      extensions: [quollVisibleEdgeRecovery({ maxWaitFrames, thawFrames })],
    }),
  });
  Object.defineProperty(view.scrollDOM, "clientWidth", {
    configurable: true,
    // While ramping, every read returns a fresh non-zero value so the wait
    // loop never sees STABLE_FRAMES consecutive equal widths (mid-ramp cap).
    get: (): number => {
      if (!widthRamping) {
        return width;
      }
      widthReads += 1;
      return 400 + widthReads;
    },
  });
  return view;
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const tick = (): void => {
      if (--left <= 0) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

function scrollTick(v: EditorView): void {
  v.scrollDOM.dispatchEvent(new Event("scroll"));
}

/** Poll a condition once per frame; throws past the cap so a hang fails loud
 *  instead of timing out the whole test. */
async function until(cond: () => boolean, capFrames = 120): Promise<void> {
  for (let i = 0; i < capFrames; i += 1) {
    if (cond()) {
      return;
    }
    await frames(1);
  }
  throw new Error("condition not reached within frame cap");
}

describe("quollVisibleEdgeRecovery — lifecycle + capture guards", () => {
  it("captures on scroll with live geometry (rAF-coalesced); skips with dead geometry", async () => {
    stubVisibility();
    const v = mount(30);
    const snap = vi.spyOn(v, "scrollSnapshot");
    scrollTick(v);
    scrollTick(v); // coalesced into the same frame
    await frames(2);
    expect(snap).toHaveBeenCalledTimes(1);
    width = 0;
    scrollTick(v);
    await frames(2);
    expect(snap).toHaveBeenCalledTimes(1); // dead geometry: no capture
  });

  it("a scroll immediately followed by a same-frame hide still captures the latest position", async () => {
    stubVisibility();
    const v = mount(30);
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    // Same synchronous turn: scroll, then hide before the next animation frame.
    // The capture must run synchronously on the scroll (before frozen), not be
    // deferred to a frame that then runs while frozen and drops it.
    scrollTick(v);
    setVisibility("hidden");
    expect(snap).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await frames(10); // wait + thaw with margin
    expect(dispatch).toHaveBeenCalledTimes(1); // the fresh snapshot is restored
  });

  it("the hidden edge freezes capture; the visible-edge restore dispatches and thaws two frames later", async () => {
    stubVisibility();
    const v = mount(30);
    scrollTick(v); // arm a snapshot
    await frames(2);
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    scrollTick(v); // teardown junk: frozen → no refresh
    await frames(2);
    expect(snap).not.toHaveBeenCalled();
    setVisibility("visible"); // width stable at 500 → restore after ~4 frames
    await frames(10); // wait (STABLE_FRAMES+1 ≈ 4) + thaw (2) with margin
    expect(dispatch).toHaveBeenCalledTimes(1); // snapshot dispatched
    scrollTick(v); // thawed: rolling capture resumed
    await frames(2);
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it("at the wait cap with dead geometry, restore skips the dispatch but keeps the snapshot for the next edge", async () => {
    stubVisibility();
    const v = mount(4);
    scrollTick(v); // arm a snapshot
    await frames(2);
    const dispatch = vi.spyOn(v, "dispatch");
    const measure = vi.spyOn(v, "requestMeasure");
    width = 0;
    setVisibility("hidden");
    setVisibility("visible");
    await frames(10); // > maxWaitFrames + thaw: cap fires with dead geometry
    expect(dispatch).not.toHaveBeenCalled();
    expect(measure).toHaveBeenCalled(); // measure still requested
    width = 500;
    setVisibility("hidden");
    setVisibility("visible");
    await frames(12); // wait (≈4) + thaw with margin
    expect(dispatch).toHaveBeenCalledTimes(1); // kept snapshot restored now
  });

  it("at the wait cap with still-ramping geometry, the heal dispatches but the good snapshot stays quarantined until the width settles", async () => {
    stubVisibility();
    const v = mount(20); // cap fires while the ramp is still running
    scrollTick(v); // arm the good snapshot at stable width (500)
    await frames(2);
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    widthRamping = true; // width changes every read → stability never reached → cap
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length > 0); // cap fired: heal dispatched
    // The ramp continues well past the (2-frame) thaw window. A scroll now must
    // NOT be captured — resuming rolling capture here would overwrite the good
    // snapshot with one taken at degenerate mid-ramp geometry (the bug).
    await frames(5);
    scrollTick(v);
    await frames(2);
    expect(snap).not.toHaveBeenCalled(); // quarantined: no mid-ramp capture
    // Width settles (within the watch budget) → the freeze lifts → capture resumes.
    widthRamping = false; // clientWidth pins to 500
    await until(() => {
      scrollTick(v);
      return snap.mock.calls.length > 0;
    });
    expect(snap).toHaveBeenCalled();
  });

  it("at the quarantine's own frame-cap expiry (geometry never settles), the freeze and the good snapshot are kept for the next visible edge", async () => {
    stubVisibility();
    const v = mount(6); // small budget: beginWait cap + thawWhenStable cap both fire fast
    scrollTick(v); // arm the good snapshot at stable width (500)
    await frames(2);
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    widthRamping = true; // never settles → beginWait caps → quarantine → its cap expires
    setVisibility("visible");
    await frames(20); // > maxWaitFrames * 2: both caps have fired, watch has stopped
    scrollTick(v);
    await frames(2);
    expect(snap).not.toHaveBeenCalled(); // frozen kept at expiry: snapshot not overwritten
    // A later visible edge with settled geometry restores the KEPT snapshot.
    widthRamping = false; // clientWidth pins to 500
    setVisibility("hidden");
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length >= 2); // heal (at cap) + kept-snapshot restore
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("destroy during the cap-path quarantine cancels the watch (its rAF stops polling clientWidth — no leak)", async () => {
    stubVisibility();
    const v = mount(6);
    scrollTick(v); // arm a snapshot
    await frames(2);
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    // Ramping never settles → beginWait caps → the quarantine watch runs, and
    // (while widthRamping) it reads clientWidth once per frame — each read bumps
    // widthReads, so the counter is a probe for whether the rAF is still alive.
    widthRamping = true;
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length > 0); // cap fired: quarantine active
    v.destroy(); // destroy mid-quarantine must cancel the watch's rAF
    view = undefined; // afterEach must not destroy the same instance twice
    const readsAtDestroy = widthReads;
    await frames(6); // a leaked watch would keep polling clientWidth across these frames
    expect(widthReads).toBe(readsAtDestroy); // no further polls: the rAF was cancelled
  });

  it("a hidden edge during the cap-path quarantine cancels the watch, keeps the freeze, and the kept snapshot serves the next edge", async () => {
    stubVisibility();
    const v = mount(20);
    scrollTick(v); // arm the good snapshot at stable width (500)
    await frames(2);
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    widthRamping = true; // never settles → cap → quarantine (thawWhenStable watching)
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length > 0); // cap fired: quarantine active
    // A hidden edge lands mid-quarantine: cancelWait() ends the watch and the
    // freeze persists — a scroll during the flap must not be captured.
    setVisibility("hidden");
    scrollTick(v);
    await frames(3);
    expect(snap).not.toHaveBeenCalled(); // frozen persisted through the flap
    // Next visible edge with settled width re-dispatches the kept good snapshot.
    widthRamping = false;
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length === 2);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("resumes rolling capture on a LATE geometry settle after the quarantine cap — no visibility edge needed", async () => {
    stubVisibility();
    const v = mount(6); // small budget: beginWait cap + thawWhenStable cap fire fast
    scrollTick(v); // arm the good snapshot at stable width (500)
    await frames(2);
    resetObserverLog(); // ignore CM's baseline RO; track only the recovery's
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    widthRamping = true; // never settles within the budget → quarantine → its cap expires
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length > 0); // heal dispatched at the cap
    // Quarantine cap expires with unsettled geometry → the ResizeObserver attaches.
    await until(() => lateSettleObserver(v) !== undefined);
    // Geometry settles just AFTER the budget, within the SAME visible session.
    widthRamping = false; // clientWidth pins to 500
    // A late resize fires → the bounded settle-check restarts → thaws once stable.
    lateSettleObserver(v)?.cb([], {} as ResizeObserver);
    await until(() => {
      scrollTick(v);
      return snap.mock.calls.length > 0;
    });
    expect(snap).toHaveBeenCalled(); // capture resumed WITHOUT another visibility edge
    expect(lateSettleObserver(v)).toBeUndefined(); // observer disconnected after thaw
  });

  it("after the quarantine cap the observer sits dormant — no resize means no capture and no width polling", async () => {
    stubVisibility();
    const v = mount(6);
    scrollTick(v); // arm the good snapshot
    await frames(2);
    resetObserverLog(); // ignore CM's baseline RO; track only the recovery's
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    widthRamping = true; // never settles → quarantine → cap → observer attaches, goes dormant
    setVisibility("visible");
    await until(() => lateSettleObserver(v) !== undefined); // cap fired: observer attached
    // Let the initial quarantine watch finish capping, then snapshot the read count.
    await frames(4);
    const readsWhenDormant = widthReads;
    // No resize callback fires. If a leaked rAF were still polling, widthReads
    // would climb across these frames (widthRamping bumps it on every read).
    await frames(10);
    expect(widthReads).toBe(readsWhenDormant); // dormant: nothing polls clientWidth
    scrollTick(v);
    await frames(2);
    expect(snap).not.toHaveBeenCalled(); // frozen held: no thaw, no capture
    // A later visible edge with settled geometry still restores the KEPT snapshot.
    widthRamping = false;
    setVisibility("hidden"); // disconnects the observer, keeps the freeze
    expect(lateSettleObserver(v)).toBeUndefined();
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length >= 2); // heal + kept-snapshot restore
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a ResizeObserver callback that arrives after destroy() is inert (no dispatch/measure/snapshot, no width poll)", async () => {
    stubVisibility();
    const v = mount(6);
    scrollTick(v); // arm a snapshot
    await frames(2);
    resetObserverLog(); // ignore CM's baseline RO; track only the recovery's
    setVisibility("hidden");
    widthRamping = true; // never settles → quarantine → cap → observer attaches
    setVisibility("visible");
    await until(() => lateSettleObserver(v) !== undefined);
    const entry = lateSettleObserver(v); // capture BEFORE destroy disconnects it
    const dispatch = vi.spyOn(v, "dispatch");
    const measure = vi.spyOn(v, "requestMeasure");
    const snap = vi.spyOn(v, "scrollSnapshot");
    v.destroy();
    view = undefined; // afterEach must not destroy twice (CM destroy is not idempotent)
    const readsAtDestroy = widthReads;
    entry?.cb([], {} as ResizeObserver); // a late browser callback races destroy
    await frames(6);
    // widthReads is the DISCRIMINATING check for the destroyed guard: a resumed
    // watch reads clientWidth each frame. dispatch/measure/snap are unreachable
    // from the RO callback path regardless (they live only in restore()), so
    // they guard against unrelated regressions, not this guard specifically.
    expect(widthReads).toBe(readsAtDestroy); // guard bailed: no new watch, no polling
    expect(dispatch).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
  });

  it("a ResizeObserver callback that arrives after a successful thaw is a no-op (frozen already false, observer disconnected)", async () => {
    // Scope note: at the point the stale callback fires here, `frozen` is already
    // false and `resizeObserver` is already null, so the `!frozen` guard clause
    // alone forces the bail — this test pins the post-thaw no-op, NOT the identity
    // clause. The identity clause's load-bearing case is pinned by the next test.
    stubVisibility();
    const v = mount(6);
    scrollTick(v); // arm the good snapshot at stable width (500)
    await frames(2);
    resetObserverLog(); // ignore CM's baseline RO; track only the recovery's
    const snap = vi.spyOn(v, "scrollSnapshot");
    setVisibility("hidden");
    widthRamping = true; // quarantine → cap → observer attaches
    setVisibility("visible");
    await until(() => lateSettleObserver(v) !== undefined);
    const entry = lateSettleObserver(v); // capture before the thaw disconnects it
    widthRamping = false; // width settles → the RO-driven watch thaws
    entry?.cb([], {} as ResizeObserver);
    await until(() => {
      scrollTick(v);
      return snap.mock.calls.length > 0; // capture resumed = thawed
    });
    const callsAfterThaw = snap.mock.calls.length;
    // Fire the SAME (now stale) callback again: post-thaw `!frozen` guard bails.
    entry?.cb([], {} as ResizeObserver);
    await frames(4);
    scrollTick(v); // one legitimate capture is fine…
    await frames(2);
    // …but the stale callback started no extra watch, so no runaway/extra behaviour.
    expect(snap.mock.calls.length).toBeGreaterThanOrEqual(callsAfterThaw);
    expect(lateSettleObserver(v)).toBeUndefined(); // stayed disconnected after thaw
  });

  it("a stale callback from a SUPERSEDED earlier-episode observer is inert while a NEW episode is frozen (identity guard is load-bearing here)", async () => {
    // The one scenario where `this.resizeObserver !== observer` is the ONLY guard
    // clause that bails: a straggling callback from episode A's observer fires
    // while episode B is legitimately frozen (destroyed=false, visible, frozen=true
    // all hold for B). If the identity check were removed, A's callback would
    // restart the shared settle-watch mid-B and poll clientWidth.
    stubVisibility();
    const v = mount(6);
    scrollTick(v); // arm a snapshot
    await frames(2);
    resetObserverLog(); // ignore CM's baseline RO; track only the recovery's
    const snap = vi.spyOn(v, "scrollSnapshot");
    // Episode A: quarantine caps (width never settles) → observer A attaches.
    setVisibility("hidden");
    widthRamping = true;
    setVisibility("visible");
    await until(() => lateSettleObserver(v) !== undefined);
    const entryA = lateSettleObserver(v); // capture A before it is superseded
    // Supersede to episode B WITHOUT letting A's callback fire: a hidden edge
    // disconnects A (freeze persists), then a visible edge starts a fresh wait
    // that also caps unsettled → observer B attaches, frozen === true again.
    setVisibility("hidden"); // stopObservingLateSettle → A disconnected, resizeObserver=null
    setVisibility("visible"); // beginWait → new quarantine (B)
    await until(() => {
      const cur = lateSettleObserver(v);
      return cur !== undefined && cur !== entryA; // B attached and is distinct from A
    });
    await frames(4); // let B's own watch cap and go idle
    const readsBeforeStale = widthReads;
    entryA?.cb([], {} as ResizeObserver); // straggling A callback fires mid-B
    await frames(6);
    // Identity guard bailed: A did not restart the watch, so no width polling and
    // B's live observer is untouched.
    expect(widthReads).toBe(readsBeforeStale);
    expect(lateSettleObserver(v)).not.toBe(entryA); // B is still the live observer
    expect(snap).not.toHaveBeenCalled(); // still frozen: no capture from the stale cb
  });

  it("destroy cancels the wait loop and the queued capture (no late dispatch/measure/snapshot)", async () => {
    stubVisibility();
    const v = mount(30);
    scrollTick(v);
    await frames(2);
    setVisibility("hidden");
    setVisibility("visible"); // wait loop armed
    const dispatch = vi.spyOn(v, "dispatch");
    const measure = vi.spyOn(v, "requestMeasure");
    const snap = vi.spyOn(v, "scrollSnapshot");
    scrollTick(v); // queue a capture frame, then destroy before it fires
    v.destroy();
    view = undefined; // afterEach must not destroy the same instance twice (CM destroy is not idempotent)
    scrollTick(v); // listener removed: inert
    setVisibility("hidden");
    setVisibility("visible");
    await frames(35);
    expect(dispatch).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
  });

  it("the restore's scroll echo inside the thaw window is not re-captured", async () => {
    stubVisibility();
    const v = mount(30, 30); // long thaw makes the window deterministic
    scrollTick(v);
    await frames(2); // arm a snapshot
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length > 0); // restore fired; thaw pending
    scrollTick(v); // the echo CM would fire after applying the snapshot scroll
    await frames(3);
    expect(snap).not.toHaveBeenCalled(); // still frozen: echo not captured
  });

  it("a hidden edge mid-thaw cancels the thaw, keeps the freeze, and the kept snapshot serves the next edge", async () => {
    stubVisibility();
    const v = mount(30, 30); // long thaw so the hidden edge lands mid-thaw
    scrollTick(v);
    await frames(2); // arm a snapshot
    const snap = vi.spyOn(v, "scrollSnapshot");
    const dispatch = vi.spyOn(v, "dispatch");
    setVisibility("hidden");
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length === 1); // first restore; thaw pending
    setVisibility("hidden"); // mid-thaw: cancels it, freeze persists
    scrollTick(v);
    await frames(3);
    expect(snap).not.toHaveBeenCalled(); // frozen persisted through the flap
    setVisibility("visible");
    await until(() => dispatch.mock.calls.length === 2); // kept snapshot re-dispatched
  });
});
