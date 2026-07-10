import { describe, expect, it } from "vitest";
import { createRevertRescueTracker } from "../../src/extension/revert-rescue.js";

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
});
