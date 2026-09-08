// @vitest-environment node
//
// The panel's `step` is the edit-settled barrier's SOLE release site, and it
// used to settle only if `runEffects` returned normally. A throwing effect
// therefore left a deferred side-channel thunk (context-handoff /
// codex-context-handoff / switch-to-text) neither DROPPED per the barrier's
// failed-apply contract nor DRAINED — it survived and ran at the NEXT settle,
// against a document that edit never landed in. `createHostSessionStep` makes
// the settle unconditional; this file pins that, the applied/failed verdict it
// carries, and the exception ordering that keeps the effect error visible.
//
// ⚠️ `test/extension/session/` is in NO tsconfig, so vitest transpiles it
// without type-checking — every assertion here must be BEHAVIOURAL. The
// exhaustiveness guard over `ApplyEditOutcome` is compile-time and lives in
// src/, where `tsc -p ./` does check it.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createEditSettledBarrier } from "../../../src/extension/session/edit-settled-barrier.js";
import {
  type ApplyEditOutcome,
  createDrainingDispatcher,
  type HostSessionEffect,
  type HostSessionEvent,
} from "../../../src/extension/session/host-session-core.js";
import {
  createHostSessionStep,
  isEditApplied,
} from "../../../src/extension/session/host-session-step.js";

// The executor's real settlement event, minus the optional `divergedAfterApply`.
const settled = (outcome: ApplyEditOutcome): HostSessionEvent => ({
  type: "applyEditSettled",
  outcome,
  canWrite: true,
  currentContent: null,
  preApplyContent: "",
});
const themeChanged: HostSessionEvent = { type: "themeChanged", themeKind: "dark" };

const harness = (opts: { effects?: () => void; settle?: () => void } = {}) => {
  const order: string[] = [];
  const settles: boolean[] = [];
  const settleErrors: unknown[] = [];
  const step = createHostSessionStep({
    commitTransition: () => {
      order.push("commit");
      return [] as readonly HostSessionEffect[];
    },
    runEffects: () => {
      order.push("effects");
      opts.effects?.();
    },
    settleEditBarrier: (applied) => {
      order.push("settle");
      settles.push(applied);
      opts.settle?.();
    },
    onSettleError: (err) => settleErrors.push(err),
  });
  return { step, order, settles, settleErrors };
};

describe("createHostSessionStep", () => {
  it("commits, runs the effects, then settles the barrier", () => {
    const h = harness();
    h.step(themeChanged);
    expect(h.order).toEqual(["commit", "effects", "settle"]);
    expect(h.settles).toEqual([true]);
  });

  it("settles the barrier as FAILED when a failed settlement's effects throw", () => {
    const boom = new Error("effect threw");
    const h = harness({
      effects: () => {
        throw boom;
      },
    });
    expect(() => h.step(settled({ kind: "rejected", message: "x" }))).toThrow(boom);
    expect(h.settles).toEqual([false]);
    expect(h.order).toEqual(["commit", "effects", "settle"]);
  });

  it("settles the barrier as APPLIED when a successful settlement's effects throw", () => {
    const boom = new Error("ack reseed threw");
    const h = harness({
      effects: () => {
        throw boom;
      },
    });
    expect(() => h.step(settled({ kind: "ok", documentVersion: 3 }))).toThrow(boom);
    expect(h.settles).toEqual([true]);
  });

  it("treats an UNVERIFIED landing as applied", () => {
    expect(isEditApplied(settled({ kind: "ok", documentVersion: null }))).toBe(true);
  });

  it("treats every non-ok outcome as NOT applied", () => {
    const nonOk: ApplyEditOutcome[] = [
      { kind: "refused" },
      { kind: "constructThrew", message: "x" },
      { kind: "applyThrew", message: "x" },
      { kind: "rejected", message: "x" },
    ];
    for (const outcome of nonOk) {
      expect(isEditApplied(settled(outcome))).toBe(false);
    }
  });

  // The outer `switch`'s default arm is unreachable by type — `HostSessionEvent`
  // is a closed union — so we cast past the type system to exercise it, the same
  // move as the reducer exhaustiveness guard in test/webview/state.test.ts. The
  // previous implementation was an early `if (event.type !== "applyEditSettled")
  // { return true; }`, which answered an unknown member with the DRAIN verdict;
  // reverting to it turns this test red, which is what makes the switch a real
  // behavioural change and not a reformat. The other half — a NEW union member
  // failing to compile — is checked by a different oracle (`tsc`, via the
  // `never` assignment), and cannot be pinned here.
  it("treats an UNKNOWN event type as NOT applied, and says so", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = { type: "no-such-event" } as unknown as HostSessionEvent;
    try {
      expect(isEditApplied(unknown)).toBe(false);
      expect(spy).toHaveBeenCalledWith(
        "[quoll] unhandled HostSessionEvent for the barrier verdict; treating the edit as NOT applied",
        unknown
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("does not settle when the transition itself throws", () => {
    const settles: boolean[] = [];
    const step = createHostSessionStep({
      commitTransition: () => {
        throw new Error("reducer bug");
      },
      runEffects: () => {},
      settleEditBarrier: (applied) => settles.push(applied),
    });
    expect(() => step(themeChanged)).toThrow("reducer bug");
    expect(settles).toEqual([]);
  });

  it("drops a deferred side channel when a failed settlement's effects throw", () => {
    let locked = true;
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => false,
      onError: () => {},
    });
    barrier.run(ran, dropped);
    expect(ran).not.toHaveBeenCalled();

    const step = createHostSessionStep({
      commitTransition: () => {
        locked = false; // the settlement released the write lock
        return [];
      },
      runEffects: () => {
        throw new Error("ack reseed threw");
      },
      settleEditBarrier: (applied) => barrier.settle(applied),
    });
    expect(() => step(settled({ kind: "rejected", message: "x" }))).toThrow();
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(ran).not.toHaveBeenCalled();

    barrier.settle(true); // not resurrected by a later successful settle
    expect(ran).not.toHaveBeenCalled();
  });

  it("still drains a deferred side channel when a SUCCESSFUL settlement's effects throw", () => {
    let locked = true;
    const ran = vi.fn();
    const dropped = vi.fn();
    const barrier = createEditSettledBarrier({
      isLocked: () => locked,
      isDisposed: () => false,
      onError: () => {},
    });
    barrier.run(ran, dropped);

    const step = createHostSessionStep({
      commitTransition: () => {
        locked = false;
        return [];
      },
      runEffects: () => {
        throw new Error("ack reseed threw");
      },
      settleEditBarrier: (applied) => barrier.settle(applied),
    });
    expect(() => step(settled({ kind: "ok", documentVersion: 3 }))).toThrow();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("keeps the effect error when the settle also throws", () => {
    const effectErr = new Error("effect threw");
    const settleErr = new Error("settle threw");
    const h = harness({
      effects: () => {
        throw effectErr;
      },
      settle: () => {
        throw settleErr;
      },
    });
    expect(() => h.step(themeChanged)).toThrow(effectErr);
    expect(h.settleErrors).toEqual([settleErr]);
  });

  it("propagates a settle throw when the effects did not throw", () => {
    const settleErr = new Error("settle threw");
    const h = harness({
      settle: () => {
        throw settleErr;
      },
    });
    expect(() => h.step(themeChanged)).toThrow(settleErr);
    expect(h.settleErrors).toEqual([]);
  });

  it("keeps the effect error when the settle AND the error reporter throw", () => {
    const effectErr = new Error("effect threw");
    const step = createHostSessionStep({
      commitTransition: () => [],
      runEffects: () => {
        throw effectErr;
      },
      settleEditBarrier: () => {
        throw new Error("settle threw");
      },
      onSettleError: () => {
        throw new Error("reporter threw");
      },
    });
    expect(() => step(themeChanged)).toThrow(effectErr);
  });

  // The panel does NOT inject `onSettleError` (see its `createHostSessionStep`
  // call), so the DEFAULT reporter is the only one production ever runs. Every
  // other test here injects one, which leaves that default unobserved — deleting
  // it was measured to keep the rest of this file green.
  it("reports a settle throw through the DEFAULT reporter when none is injected", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const effectErr = new Error("effect threw");
    const settleErr = new Error("settle threw");
    const step = createHostSessionStep({
      commitTransition: () => [],
      runEffects: () => {
        throw effectErr;
      },
      settleEditBarrier: () => {
        throw settleErr;
      },
      // no onSettleError — this is the panel's wiring
    });
    expect(() => step(themeChanged)).toThrow(effectErr);
    expect(spy).toHaveBeenCalledWith("[quoll] edit-settled barrier threw", settleErr);
    spy.mockRestore();
  });

  // `effectsError` is BOXED on purpose. Every other test throws an `Error`, so an
  // unboxed `let effectsError: unknown = null` stays green throughout — this is
  // the only case that separates "the effects threw a falsy value" from "the
  // effects completed", and getting it wrong hands the caller the SETTLE error
  // (the recovery path masking the failure it was recovering from).
  it("keeps a FALSY effect error (throw null) when the settle also throws", () => {
    const settleErr = new Error("settle threw");
    const reported: unknown[] = [];
    const step = createHostSessionStep({
      commitTransition: () => [],
      runEffects: () => {
        // A non-Error throw is the whole point of this test: it is the value the
        // boxing exists for, so the rule is suppressed rather than satisfied.
        // biome-ignore lint/style/useThrowOnlyError: pins the falsy-throw contract
        throw null;
      },
      settleEditBarrier: () => {
        throw settleErr;
      },
      onSettleError: (err) => reported.push(err),
    });
    let thrown: unknown = "NOTHING THROWN";
    try {
      step(themeChanged);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(null); // the effect error, not the settle error
    expect(reported).toEqual([settleErr]);
  });

  // Also pins today's dispatcher behaviour on a throwing step: a re-entrant
  // dispatch issued before the throw stays QUEUED and is only drained by the
  // next external dispatch. That residue is a separate, pre-existing gap
  // (tracked as its own TODO); these assertions are its measured baseline, so
  // changing that policy must consciously update them.
  it("settles through the real dispatcher and pins today's queue residue on a throw", () => {
    const settles: boolean[] = [];
    const seen: string[] = [];
    let dispatch!: (event: HostSessionEvent) => void;
    let firstEffects = true;
    dispatch = createDrainingDispatcher<HostSessionEvent>(
      createHostSessionStep({
        commitTransition: (event) => {
          // Qualify the theme events by themeKind: on `event.type` alone the
          // stale re-entrant event and the new one collapse to the same string,
          // and a LIFO drain would read identical to a FIFO one.
          seen.push(event.type === "themeChanged" ? `themeChanged:${event.themeKind}` : event.type);
          return [];
        },
        runEffects: () => {
          if (!firstEffects) {
            return;
          }
          firstEffects = false;
          // Enqueued behind the active drain, then abandoned by the throw.
          dispatch({ type: "themeChanged", themeKind: "light" });
          throw new Error("effect threw");
        },
        settleEditBarrier: (applied) => settles.push(applied),
      })
    );
    expect(() => dispatch(settled({ kind: "refused" }))).toThrow();
    expect(settles).toEqual([false]); // settled despite the throw
    expect(seen).toEqual(["applyEditSettled"]); // the re-entrant event is still queued
    dispatch(themeChanged); // the drain guard was released by the dispatcher's finally
    expect(seen).toEqual([
      "applyEditSettled",
      "themeChanged:light", // the stale re-entrant event, drained FIRST
      "themeChanged:dark",
    ]);
    expect(settles).toEqual([false, true, true]);
  });

  // Catches a full revert of the panel to an inline `step`; it does NOT catch a
  // hypothetical second inline step living alongside the factory. Comments are
  // stripped first so a mention in prose cannot satisfy the pin.
  it("is the panel's step composition, wired into the dispatcher", () => {
    const panel = readFileSync(
      new URL("../../../src/extension/session/quoll-editor-panel.ts", import.meta.url),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      // Trailing line comments. This also truncates any "//" inside a string,
      // which only ever removes text — it can narrow the haystack, never
      // manufacture a match, so it cannot vacate the pin.
      .replace(/^(.*?)\/\/.*$/gm, "$1");
    expect(panel).toContain('createHostSessionStep } from "./host-session-step.js"');
    expect(panel).toContain("const step = createHostSessionStep({");
    // The barrier's SOLE release site: pin that the panel really hands the
    // factory the live barrier's `settle`, not a stub. Two loose substrings
    // rather than one exact line, so reformatting cannot vacate the pin.
    expect(panel).toContain("settleEditBarrier:");
    expect(panel).toMatch(/settleEditBarrier:[\s\S]{0,80}editSettledBarrier\.settle\(/);
    expect(panel).toContain("createDrainingDispatcher<HostSessionEvent>(step)");
  });
});
