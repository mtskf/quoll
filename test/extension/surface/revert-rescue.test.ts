import { describe, expect, it } from "vitest";
import { createRevertRescueTracker } from "../../../src/extension/surface/revert-rescue.js";

const ctx = (
  over: Partial<Parameters<ReturnType<typeof createRevertRescueTracker>["decideOnDispose"]>[0]> = {}
) => ({
  writeInFlight: false,
  hasSurvivingEditor: true,
  canWrite: true,
  currentContent: "DISK",
  disposedAt: 1000,
  ...over,
});

describe("revert-rescue tracker", () => {
  it("rescues a close-triggered revert while another editor survives", () => {
    const t = createRevertRescueTracker({ windowMs: 2500 });
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 995 }); // revert (content changed)
    expect(t.decideOnDispose(ctx({ disposedAt: 1000 }))).toEqual({
      rescue: true,
      content: "DIRTY",
    });
  });

  it("does NOT rescue a save (content unchanged going clean)", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DIRTY", at: 5 }); // save: disk now holds DIRTY
    expect(t.decideOnDispose(ctx({ currentContent: "DIRTY", disposedAt: 10 }))).toEqual({
      rescue: false,
    });
  });

  it("does NOT rescue when the revert is stale (user reverted earlier, then closed later)", () => {
    const t = createRevertRescueTracker({ windowMs: 2500 });
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 100 }); // manual revert
    expect(t.decideOnDispose(ctx({ disposedAt: 5000 }))).toEqual({ rescue: false }); // 4900ms later
  });

  it("does NOT rescue when no other editor survives (honour a real discard)", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 5 });
    expect(t.decideOnDispose(ctx({ hasSurvivingEditor: false, disposedAt: 10 }))).toEqual({
      rescue: false,
    });
  });

  it("does NOT rescue when a reducer applyEdit was in flight at dispose (avoid a racing writer)", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 5 });
    expect(t.decideOnDispose(ctx({ writeInFlight: true, disposedAt: 10 }))).toEqual({
      rescue: false,
    });
  });

  it("does NOT rescue when read-only", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 5 });
    expect(t.decideOnDispose(ctx({ canWrite: false, disposedAt: 10 }))).toEqual({ rescue: false });
  });

  it("a fresh dirty edit supersedes a prior pending revert", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "A", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 5 }); // revert armed (A)
    t.observe({ isDirty: true, content: "B", at: 6 }); // new edit supersedes
    t.observe({ isDirty: false, content: "DISK", at: 7 }); // second revert -> content B
    expect(t.decideOnDispose(ctx({ disposedAt: 10 }))).toEqual({ rescue: true, content: "B" });
  });

  it("no rescue when nothing was ever dirty", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: false, content: "DISK", at: 0 });
    expect(t.decideOnDispose(ctx({ disposedAt: 10 }))).toEqual({ rescue: false });
  });

  it("no rescue when currentContent already equals the pending dirty content", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 5 });
    expect(t.decideOnDispose(ctx({ currentContent: "DIRTY", disposedAt: 10 }))).toEqual({
      rescue: false,
    });
  });

  it("seeded dirty at construction, reverted on close, rescues (the reported bug: no edit after open)", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "DIRTY", at: 0 }); // construction seed
    // ...no further change events (user never edits in Quoll)...
    t.observe({ isDirty: false, content: "DISK", at: 900 }); // close-triggered revert
    expect(t.decideOnDispose(ctx({ disposedAt: 905 }))).toEqual({ rescue: true, content: "DIRTY" });
  });

  it("a trailing empty clean event does NOT disarm an armed revert", () => {
    const t = createRevertRescueTracker();
    t.observe({ isDirty: true, content: "DIRTY", at: 0 });
    t.observe({ isDirty: false, content: "DISK", at: 5 }); // revert (content-change event) -> armed
    t.observe({ isDirty: false, content: "DISK", at: 6 }); // trailing empty dirty-flip clean event
    expect(t.decideOnDispose(ctx({ disposedAt: 10 }))).toEqual({ rescue: true, content: "DIRTY" });
  });

  // An UNDO back to clean must NOT arm (the user deliberately discarded their own
  // edits). Verified (PR #155): VS Code fires an undo as TWO events — a still-DIRTY
  // content change back to the disk bytes, then the dirty->clean flip. The first
  // resets lastDirtyContent to disk, so the flip's content EQUALS it and classifies
  // as a SAVE (no arm). This is why the existing content-comparison already handles
  // undo-to-clean and a TextDocumentChangeReason discriminator was unnecessary (the
  // flip carries reason === undefined regardless). Contrast: a close-triggered
  // revert fires ONE clean event with changed content (armed by the first case above).
  it("an undo-to-clean (dirty content-change to disk, then clean flip) does NOT arm", () => {
    const t = createRevertRescueTracker({ windowMs: 2500 });
    t.observe({ isDirty: true, content: "DIRTY", at: 0 }); // construction seed: doc dirty
    t.observe({ isDirty: true, content: "DISK", at: 5 }); // undo event 1: still dirty, content back to disk
    t.observe({ isDirty: false, content: "DISK", at: 6 }); // undo event 2: clean flip, content unchanged
    expect(t.decideOnDispose(ctx({ disposedAt: 10 }))).toEqual({ rescue: false });
  });

  const aliveCtx = (
    over: Partial<
      Parameters<ReturnType<typeof createRevertRescueTracker>["decideOnAliveRevert"]>[0]
    > = {}
  ) => ({
    writeInFlight: false,
    canWrite: true,
    currentContent: "DISK",
    at: 1000,
    ...over,
  });

  describe("decideOnAliveRevert (two-token causal pairing)", () => {
    it("rescues when a revert then a tightly-paired close arrive (revert-first)", () => {
      const t = createRevertRescueTracker({ windowMs: 2500, pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 990 }); // revert armed
      t.observeTextTabClose(999); // close 9ms later (paired)
      expect(t.decideOnAliveRevert(aliveCtx({ at: 1000 }))).toEqual({
        rescue: true,
        content: "DIRTY",
      });
    });

    it("rescues when a close then a tightly-paired revert arrive (close-first)", () => {
      const t = createRevertRescueTracker({ windowMs: 2500, pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observeTextTabClose(990); // close first
      t.observe({ isDirty: false, content: "DISK", at: 999 }); // revert 9ms later (paired)
      expect(t.decideOnAliveRevert(aliveCtx({ at: 1000 }))).toEqual({
        rescue: true,
        content: "DIRTY",
      });
    });

    it("CONSUMES both tokens (a second decide after a rescue is a no-op)", () => {
      const t = createRevertRescueTracker({ windowMs: 2500, pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 990 });
      t.observeTextTabClose(999);
      expect(t.decideOnAliveRevert(aliveCtx({ at: 1000 })).rescue).toBe(true);
      expect(t.decideOnAliveRevert(aliveCtx({ at: 1001 }))).toEqual({ rescue: false });
    });

    it("does NOT rescue a manual revert with NO close (external wins)", () => {
      const t = createRevertRescueTracker({ pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 5 }); // manual revert, no close
      expect(t.decideOnAliveRevert(aliveCtx({ at: 10 }))).toEqual({ rescue: false });
    });

    it("does NOT resurrect a manual revert via a LATER unrelated close (Codex #1)", () => {
      const t = createRevertRescueTracker({ windowMs: 2500, pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 0 }); // manual revert at t=0
      t.observeTextTabClose(300); // unrelated close 300ms later (NOT paired: 300 > 250)
      expect(t.decideOnAliveRevert(aliveCtx({ at: 300 }))).toEqual({ rescue: false });
    });

    // Codex #2 (the reverse order of Codex #1, exercising the SHIPPED default
    // pairingWindowMs): an unrelated same-doc close, THEN a human-timed manual
    // Revert File must NOT pair — the lingering close token cannot resurrect a
    // later manual revert. 200 ms is below any real human perceive-then-invoke
    // latency yet ≥ the 120 ms default, so it is firmly outside the window.
    it("does NOT resurrect a later manual revert via an EARLIER unrelated close (default window)", () => {
      const t = createRevertRescueTracker(); // shipped default pairingWindowMs
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observeTextTabClose(0); // unrelated close first
      t.observe({ isDirty: false, content: "DISK", at: 200 }); // manual revert 200ms later
      expect(t.decideOnAliveRevert(aliveCtx({ at: 200 }))).toEqual({ rescue: false });
    });

    // Guard the OTHER side of the default: a genuine close-with-discard whose
    // close and revert are ~1 ms apart still pairs under the shipped default.
    it("DOES rescue a genuine close-first pair ~1ms apart (default window)", () => {
      const t = createRevertRescueTracker(); // shipped default pairingWindowMs
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observeTextTabClose(1000); // close
      t.observe({ isDirty: false, content: "DISK", at: 1001 }); // revert 1ms later (paired)
      expect(t.decideOnAliveRevert(aliveCtx({ at: 1001 }))).toEqual({
        rescue: true,
        content: "DIRTY",
      });
    });

    it("does NOT rescue a close with NO revert armed (nothing to restore)", () => {
      const t = createRevertRescueTracker({ pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observeTextTabClose(10); // close but no revert followed
      expect(t.decideOnAliveRevert(aliveCtx({ at: 12 }))).toEqual({ rescue: false });
    });

    it("does NOT rescue a save (content unchanged going clean) even if a close pairs", () => {
      const t = createRevertRescueTracker({ pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DIRTY", at: 5 }); // save: disk holds DIRTY
      t.observeTextTabClose(6);
      expect(t.decideOnAliveRevert(aliveCtx({ currentContent: "DIRTY", at: 10 }))).toEqual({
        rescue: false,
      });
    });

    it("does NOT rescue when a reducer applyEdit is in flight (avoid racing the writer)", () => {
      const t = createRevertRescueTracker({ pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 5 });
      t.observeTextTabClose(6);
      expect(t.decideOnAliveRevert(aliveCtx({ writeInFlight: true, at: 10 }))).toEqual({
        rescue: false,
      });
    });

    it("does NOT rescue when read-only", () => {
      const t = createRevertRescueTracker({ pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 5 });
      t.observeTextTabClose(6);
      expect(t.decideOnAliveRevert(aliveCtx({ canWrite: false, at: 10 }))).toEqual({
        rescue: false,
      });
    });

    it("does NOT rescue when currentContent already equals the pending dirty content", () => {
      const t = createRevertRescueTracker({ pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 5 });
      t.observeTextTabClose(6);
      expect(t.decideOnAliveRevert(aliveCtx({ currentContent: "DIRTY", at: 10 }))).toEqual({
        rescue: false,
      });
    });

    it("does NOT rescue an ancient paired set (absolute freshness bound)", () => {
      const t = createRevertRescueTracker({ windowMs: 2500, pairingWindowMs: 250 });
      t.observe({ isDirty: true, content: "DIRTY", at: 0 });
      t.observe({ isDirty: false, content: "DISK", at: 100 });
      t.observeTextTabClose(105); // paired (5ms) but...
      expect(t.decideOnAliveRevert(aliveCtx({ at: 5000 }))).toEqual({ rescue: false }); // 4.9s later
    });
  });
});
