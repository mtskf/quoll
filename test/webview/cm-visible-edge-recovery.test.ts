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

afterEach(() => {
  view?.destroy();
  view = undefined;
  delete (document as { visibilityState?: unknown }).visibilityState;
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
    get: () => width,
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
