// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  createEffectExecutor,
  type EffectExecutorDeps,
} from "../../../src/extension/session/effect-executor.js";
import type { HostToWebview } from "../../../src/shared/protocol.js";

const themeMsg: HostToWebview = { protocol: 1, type: "theme", themeKind: "dark" };

// Minimal deps factory — overridable per test. Unused seams throw if hit so a
// test that accidentally reaches them fails loudly instead of silently passing.
function makeDeps(over: Partial<EffectExecutorDeps> = {}): EffectExecutorDeps {
  return {
    isDisposed: () => false,
    getState: () => {
      throw new Error("getState not stubbed");
    },
    uriString: () => "file:///test.md",
    dispatch: vi.fn(),
    send: vi.fn(async () => true),
    recordEvent: vi.fn(),
    showError: vi.fn(),
    canWrite: () => true,
    buildSeedDocument: (v, externalEpoch, epochGeneration) => ({
      protocol: 1,
      type: "document",
      content: "",
      docVersion: v,
      canWrite: true,
      themeKind: "light",
      externalEpoch,
      epochGeneration,
    }),
    buildRejectedDraft: (content, v, externalEpoch, epochGeneration) => ({
      protocol: 1,
      type: "document",
      content,
      docVersion: v,
      canWrite: true,
      themeKind: "light",
      externalEpoch,
      epochGeneration,
    }),
    buildTheme: (themeKind) => ({ protocol: 1, type: "theme", themeKind }),
    buildEditRejected: (error) => ({ protocol: 1, type: "edit-rejected", error }),
    applyEditSeam: {
      readText: () => "",
      readVersion: () => 0,
      readCanonical: () => "",
      canonicalize: (text) => text,
      build: () => ({}),
      apply: async () => true,
    },
    openExternal: vi.fn(),
    ...over,
  };
}

describe("effect-executor post()", () => {
  it("disposed: never calls send, never records", () => {
    const send = vi.fn(async () => true);
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ isDisposed: () => true, send, recordEvent }));
    post(themeMsg);
    expect(send).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("ok=true: records the delivered event", async () => {
    let resolveSend!: (ok: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        })
    );
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    post(themeMsg);
    resolveSend(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).toHaveBeenCalledWith(themeMsg);
  });

  it("ok=false: does NOT record", async () => {
    const send = vi.fn(async () => false);
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    post(themeMsg);
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("reject: does NOT record, does not throw", async () => {
    const send = vi.fn(() => Promise.reject(new Error("detached")));
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    expect(() => post(themeMsg)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("send() synchronous throw: swallowed (no throw to caller), never records", async () => {
    const send = vi.fn(() => {
      throw new Error("sync transport throw");
    });
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(makeDeps({ send, recordEvent }));
    expect(() => post(themeMsg)).not.toThrow();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  // error-handler A: the .then OK-arm inner disposed guard. If the implementer
  // drops it, recordEvent fires post-dispose and this goes red.
  it("ok=true after dispose: does NOT record (inner .then disposed guard)", async () => {
    let disposed = false;
    let resolveSend!: (ok: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        })
    );
    const recordEvent = vi.fn();
    const { post } = createEffectExecutor(
      makeDeps({ isDisposed: () => disposed, send, recordEvent })
    );
    post(themeMsg);
    disposed = true;
    resolveSend(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

import type { HostSessionState } from "../../../src/extension/session/host-session-core.js";

// A state with no pending edit.
const noStash = { pendingEdit: null } as unknown as HostSessionState;

// Flush the executor's async settlement (executeDocumentWrite awaits the apply,
// then runApplyEdit's `.then` dispatches) — a handful of microtask turns.
const flushSettle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

// A verified-write seam (adapter) modelling one settlement. Defaults land
// content "new" cleanly (settled === intended → applied). readText "old" keeps
// the span non-no-op for content !== "old".
function seamFor(over: Partial<EffectExecutorDeps["applyEditSeam"]> = {}) {
  return {
    readText: () => "old",
    readVersion: () => 1,
    readCanonical: () => "new",
    canonicalize: (t: string) => t,
    build: () => ({}),
    apply: async () => true,
    ...over,
  };
}

// Run one applyEdit through the wrapper and return the dispatch spy.
async function runApply(
  seamOver: Partial<EffectExecutorDeps["applyEditSeam"]> = {},
  depsOver: Partial<EffectExecutorDeps> = {},
  content = "new"
) {
  const dispatch = vi.fn();
  const { runEffects } = createEffectExecutor(
    makeDeps({ dispatch, getState: () => noStash, applyEditSeam: seamFor(seamOver), ...depsOver })
  );
  runEffects([{ type: "applyEdit", content, baseDocVersion: 6 }]);
  await flushSettle();
  return dispatch;
}

// The wrapper is a THIN mapper over the document-write executor: the write
// pipeline itself (no-op skip, build/apply throw detection, canonical reads,
// divergence compare) is pinned in test/extension/document-write. These tests
// pin the MAPPING — tagged outcome → applyEditSettled event — and the
// dispatch-EVEN-post-dispose stash-drain safety.
describe("effect-executor runApplyEdit (wrapper mapping)", () => {
  it("applied → ok(settledVersion) + settled snapshots + divergedAfterApply false", async () => {
    const dispatch = await runApply({ readVersion: () => 8, readCanonical: () => "new" });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: 8 },
        currentContent: "new", // from the outcome's settledContent, not a re-read
        preApplyContent: "old", // canonical pre-apply, populated for ok too
        divergedAfterApply: false,
      })
    );
  });

  it("diverged (settled !== intended, apply ok) → ok + divergedAfterApply true", async () => {
    const dispatch = await runApply({ readVersion: () => 8, readCanonical: () => "CORRUPTED" });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: 8 },
        currentContent: "CORRUPTED",
        divergedAfterApply: true,
      })
    );
  });

  it("applyRefused → refused", async () => {
    const dispatch = await runApply({ apply: async () => false });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applyEditSettled", outcome: { kind: "refused" } })
    );
  });

  it("buildThrew → constructThrew(message)", async () => {
    const dispatch = await runApply({
      build: () => {
        throw new Error("boom-build");
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "constructThrew", message: "boom-build" }),
      })
    );
  });

  it("applyThrew (sync) → applyThrew(message)", async () => {
    const dispatch = await runApply({
      apply: () => {
        throw new Error("boom-apply");
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "applyThrew", message: "boom-apply" }),
      })
    );
  });

  it("applyRejected → rejected(message)", async () => {
    const dispatch = await runApply({ apply: () => Promise.reject(new Error("rej")) });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "rejected", message: "rej" }),
      })
    );
  });

  it("threads the live canWrite onto the settlement event", async () => {
    const dispatch = await runApply({}, { canWrite: () => false });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applyEditSettled", canWrite: false })
    );
  });

  // Stash-drain safety (error-handler C/D): the settlement must dispatch EVEN
  // post-dispose — for the ok arm AND the refused arm — so a one-more-char stash
  // typed during the in-flight apply can still drain after onDidDispose.
  it("ok settlement dispatches EVEN when disposed (stash-drain safety)", async () => {
    const dispatch = await runApply({ readVersion: () => 9 }, { isDisposed: () => true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: 9 },
      })
    );
  });

  it("refused settlement dispatches EVEN when disposed (stash-drain safety)", async () => {
    const dispatch = await runApply({ apply: async () => false }, { isDisposed: () => true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "applyEditSettled", outcome: { kind: "refused" } })
    );
  });

  // Contract: the wrapper maps from the OUTCOME and does not re-read the
  // document. For an ok settlement the executor reads the settled version once
  // (inside verify); the wrapper must NOT read it again (a re-read could observe
  // a later edit and mis-version the settlement).
  it("does NOT re-read the document version after the outcome (maps from settledVersion)", async () => {
    const readVersion = vi.fn(() => 5);
    const dispatch = await runApply({ readVersion });
    // Exactly one version read — the executor's verify. The wrapper adds none.
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "ok", documentVersion: 5 } })
    );
  });
});

const rejErr = { code: "unsafe_url", message: "bad" } as const;

describe("effect-executor sendEditRejected (via postEditRejected effect)", () => {
  // readVersion → 11 so the editRejectedDeliveryFailed dispatch's documentVersion
  // is a distinctive value read from the live seam (not the stale
  // lastAppliedDocVersion 3) — the recovery reseed must carry the live version.
  function runReject(over: Partial<EffectExecutorDeps> = {}) {
    const { runEffects } = createEffectExecutor(
      makeDeps({
        getState: () => ({ lastAppliedDocVersion: 3 }) as unknown as HostSessionState,
        applyEditSeam: {
          readText: () => "",
          readVersion: () => 11,
          readCanonical: () => "",
          canonicalize: (t) => t,
          build: () => ({}),
          apply: async () => true,
        },
        ...over,
      })
    );
    runEffects([{ type: "postEditRejected", error: rejErr, id: 42 }]);
  }

  it("ok=true: records, no editRejectedDeliveryFailed dispatch", async () => {
    const dispatch = vi.fn();
    const recordEvent = vi.fn();
    runReject({ send: vi.fn(async () => true), dispatch, recordEvent });
    await Promise.resolve();
    await Promise.resolve();
    expect(recordEvent).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ok=false: dispatches editRejectedDeliveryFailed(id)", async () => {
    const dispatch = vi.fn();
    runReject({ send: vi.fn(async () => false), dispatch });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });

  it("reject: dispatches editRejectedDeliveryFailed(id)", async () => {
    const dispatch = vi.fn();
    runReject({ send: () => Promise.reject(new Error("x")), dispatch });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });

  it("send() sync throw: dispatches editRejectedDeliveryFailed(id) synchronously", () => {
    const dispatch = vi.fn();
    runReject({
      send: () => {
        throw new Error("sync");
      },
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });

  it("disposed before send: early return, no send, no dispatch", () => {
    const dispatch = vi.fn();
    const send = vi.fn(async () => true);
    runReject({ isDisposed: () => true, send, dispatch });
    expect(send).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // error-handler B: both .then arms carry a disposed guard. Pinned HERE (in the
  // task that implements them), not deferred — a dropped guard would dispatch
  // editRejectedDeliveryFailed into a disposed panel and violate the reducer's
  // post-dispose invariant.
  it("disposed after send, before OK-false callback: no editRejectedDeliveryFailed", async () => {
    let disposed = false;
    let resolveSend!: (ok: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSend = r;
        })
    );
    const dispatch = vi.fn();
    runReject({ isDisposed: () => disposed, send, dispatch });
    disposed = true;
    resolveSend(false); // false arm would dispatch — but disposed guard blocks it
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("disposed after send, before reject callback: no editRejectedDeliveryFailed", async () => {
    let disposed = false;
    let rejectSend!: (err: unknown) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((_res, rej) => {
          rejectSend = rej;
        })
    );
    const dispatch = vi.fn();
    runReject({ isDisposed: () => disposed, send, dispatch });
    disposed = true;
    rejectSend(new Error("detached"));
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Codex #4: sendEditRejected wraps `Promise.resolve(pending).then(...)` so a
  // non-standard Thenable that resolves its callback SYNCHRONOUSLY cannot
  // re-enter the active dispatch drain — the feedback lands in a fresh
  // microtask. If someone replaces it with a bare `pending.then`, the dispatch
  // fires synchronously and this goes red.
  it("sync-resolving thenable: editRejectedDeliveryFailed lands in a microtask, not synchronously", async () => {
    const dispatch = vi.fn();
    // A thenable whose then() invokes the callback synchronously with false.
    const syncThenable = {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable for testing Promise.resolve assimilation
      then: (onF: (ok: boolean) => void) => {
        onF(false);
      },
    } as unknown as Thenable<boolean>;
    runReject({ send: () => syncThenable, dispatch });
    expect(dispatch).not.toHaveBeenCalled(); // deferred by Promise.resolve assimilation
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: "editRejectedDeliveryFailed",
      id: 42,
      documentVersion: 11,
    });
  });
});

describe("effect-executor runEffects other cases", () => {
  it("postDocument: posts a document message", async () => {
    const send = vi.fn(async () => true);
    const buildSeedDocument = vi.fn(
      (v: number) =>
        ({
          protocol: 1,
          type: "document",
          content: "x",
          docVersion: v,
          canWrite: true,
          themeKind: "light",
        }) as HostToWebview
    );
    const { runEffects } = createEffectExecutor(makeDeps({ send, buildSeedDocument }));
    runEffects([{ type: "postDocument", docVersion: 5, externalEpoch: 2, epochGeneration: 88 }]);
    // The builder receives the core-managed identity pair from the effect.
    expect(buildSeedDocument).toHaveBeenCalledWith(5, 2, 88);
    expect(send).toHaveBeenCalled();
  });

  it("postRejectedDraft: posts document THEN routes edit-rejected via sendEditRejected", async () => {
    const calls: string[] = [];
    const send = vi.fn(async (m: HostToWebview) => {
      calls.push(m.type);
      return true;
    });
    const { runEffects } = createEffectExecutor(
      makeDeps({
        send,
        getState: () => ({ lastAppliedDocVersion: 0 }) as unknown as HostSessionState,
      })
    );
    runEffects([
      {
        type: "postRejectedDraft",
        content: "c",
        docVersion: 2,
        externalEpoch: 0,
        epochGeneration: 1,
        error: rejErr,
        id: 9,
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    // document first, edit-rejected second (order is load-bearing)
    expect(calls).toEqual(["document", "edit-rejected"]);
  });

  it("postTheme: posts a theme message", () => {
    const send = vi.fn(async () => true);
    const { runEffects } = createEffectExecutor(makeDeps({ send }));
    runEffects([{ type: "postTheme", themeKind: "hc-light" }]);
    expect(send).toHaveBeenCalled();
  });

  it("showError: forwards to deps.showError", () => {
    const showError = vi.fn();
    const { runEffects } = createEffectExecutor(makeDeps({ showError }));
    runEffects([{ type: "showError", message: "nope" }]);
    expect(showError).toHaveBeenCalledWith("nope");
  });

  it("openExternal: forwards href to deps.openExternal", () => {
    const openExternal = vi.fn();
    const { runEffects } = createEffectExecutor(makeDeps({ openExternal }));
    runEffects([{ type: "openExternal", href: "https://x.test" }]);
    expect(openExternal).toHaveBeenCalledWith("https://x.test");
  });

  it("logWarn: does not throw, does not post", () => {
    const send = vi.fn(async () => true);
    const { runEffects } = createEffectExecutor(makeDeps({ send }));
    expect(() => runEffects([{ type: "logWarn", message: "w", detail: {} }])).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  // Codex #5: builder freshness. The seed builder must be CALLED at each
  // postDocument (reading live theme/canWrite), not memoised at factory
  // construction. Flip a live value between factory build and the effect, and
  // assert the second postDocument carries the NEW value.
  it("postDocument re-invokes the builder each time (live freshness)", () => {
    let themeKind: "light" | "dark" = "light";
    const seen: string[] = [];
    const send = vi.fn(async (m: HostToWebview) => {
      seen.push((m as { themeKind: string }).themeKind);
      return true;
    });
    const buildSeedDocument = (v: number): HostToWebview =>
      ({
        protocol: 1,
        type: "document",
        content: "",
        docVersion: v,
        canWrite: true,
        themeKind,
        externalEpoch: 0,
        epochGeneration: 1,
      }) as HostToWebview;
    const { runEffects } = createEffectExecutor(makeDeps({ send, buildSeedDocument }));
    runEffects([{ type: "postDocument", docVersion: 1, externalEpoch: 0, epochGeneration: 1 }]);
    themeKind = "dark"; // theme changes AFTER the factory was built
    runEffects([{ type: "postDocument", docVersion: 2, externalEpoch: 0, epochGeneration: 1 }]);
    expect(seen).toEqual(["light", "dark"]);
  });
});
