import { describe, expect, it, vi } from "vitest";

import { createEditSettledBarrier } from "../../src/extension/edit-settled-barrier.js";

describe("createEditSettledBarrier", () => {
  it("runs the side channel immediately when the lock is free", () => {
    const barrier = createEditSettledBarrier({ isLocked: () => false, isDisposed: () => false });
    const calls: string[] = [];
    barrier.run(() => calls.push("a"));
    expect(calls).toEqual(["a"]);
  });

  it("defers while the lock is held, draining on a SUCCESSFUL settle after release", () => {
    let locked = true;
    const barrier = createEditSettledBarrier({ isLocked: () => locked, isDisposed: () => false });
    const calls: string[] = [];
    barrier.run(() => calls.push("a"));
    expect(calls).toEqual([]); // deferred — lock held

    barrier.settle(true); // still locked → drains nothing
    expect(calls).toEqual([]);

    locked = false;
    barrier.settle(true); // lock released + applied ok → drain
    expect(calls).toEqual(["a"]);
  });

  it("does NOT drain while the lock was re-acquired (stash-drain re-apply)", () => {
    let locked = true;
    const barrier = createEditSettledBarrier({ isLocked: () => locked, isDisposed: () => false });
    const calls: string[] = [];
    barrier.run(() => calls.push("a"));

    barrier.settle(true); // re-acquired → still locked → no drain
    expect(calls).toEqual([]);

    locked = false;
    barrier.settle(true);
    expect(calls).toEqual(["a"]);
  });

  it("DROPS deferred side channels on a FAILED apply (applied=false)", () => {
    let locked = true;
    const barrier = createEditSettledBarrier({ isLocked: () => locked, isDisposed: () => false });
    const calls: string[] = [];
    barrier.run(() => calls.push("a"));

    // Failed apply releases the lock but must NOT run the deferred handoff
    // (the edit never landed → pre-edit state).
    locked = false;
    barrier.settle(false);
    expect(calls).toEqual([]);

    // A later successful settle finds nothing (already dropped).
    barrier.settle(true);
    expect(calls).toEqual([]);
  });

  it("drains deferred side channels in FIFO order", () => {
    let locked = true;
    const barrier = createEditSettledBarrier({ isLocked: () => locked, isDisposed: () => false });
    const calls: string[] = [];
    barrier.run(() => calls.push("first"));
    barrier.run(() => calls.push("second"));
    locked = false;
    barrier.settle(true);
    expect(calls).toEqual(["first", "second"]);
  });

  it("drops deferred side channels on dispose and never runs them", () => {
    let locked = true;
    let disposed = false;
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => disposed,
    });
    const calls: string[] = [];
    barrier.run(() => calls.push("a"));

    disposed = true;
    locked = false;
    barrier.settle(true);
    expect(calls).toEqual([]);
  });

  it("does not run a side channel requested after dispose", () => {
    const barrier = createEditSettledBarrier({ isLocked: () => false, isDisposed: () => true });
    const calls: string[] = [];
    barrier.run(() => calls.push("a"));
    expect(calls).toEqual([]);
  });

  it("isolates a throwing deferred thunk so later thunks still run (onError)", () => {
    let locked = true;
    const onError = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => false,
      onError,
    });
    const calls: string[] = [];
    barrier.run(() => {
      throw new Error("boom");
    });
    barrier.run(() => calls.push("after"));
    locked = false;
    barrier.settle(true);
    expect(calls).toEqual(["after"]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("isolates a throwing IMMEDIATE thunk (lock free) via onError", () => {
    const onError = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => false,
      isDisposed: () => false,
      onError,
    });
    barrier.run(() => {
      throw new Error("boom");
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("settle is a cheap no-op when nothing is deferred", () => {
    const barrier = createEditSettledBarrier({ isLocked: () => false, isDisposed: () => false });
    expect(() => barrier.settle(true)).not.toThrow();
    expect(() => barrier.settle(false)).not.toThrow();
  });
});
