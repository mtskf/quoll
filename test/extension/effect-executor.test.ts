// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  createEffectExecutor,
  type EffectExecutorDeps,
} from "../../src/extension/session/effect-executor.js";
import type { HostToWebview } from "../../src/shared/protocol.js";

const themeMsg: HostToWebview = { protocol: 1, type: "theme", isDarkTheme: true };

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
    buildSeedDocument: (v) => ({
      protocol: 1,
      type: "document",
      content: "",
      docVersion: v,
      canWrite: true,
      isDarkTheme: false,
    }),
    buildRejectedDraft: (content, v) => ({
      protocol: 1,
      type: "document",
      content,
      docVersion: v,
      canWrite: true,
      isDarkTheme: false,
    }),
    buildTheme: (isDarkTheme) => ({ protocol: 1, type: "theme", isDarkTheme }),
    buildEditRejected: (error) => ({ protocol: 1, type: "edit-rejected", error }),
    applyEditSeam: {
      readText: () => "",
      readVersion: () => 0,
      readCanonical: () => "",
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

import type { HostSessionState } from "../../src/extension/session/host-session-core.js";

// A state with no pending edit (drainSnapshot skips readCanonical).
const noStash = { pendingEdit: null } as unknown as HostSessionState;

describe("effect-executor runApplyEdit (via applyEdit effect)", () => {
  it("no-op span: settles ok with unchanged version, does NOT call apply", () => {
    const dispatch = vi.fn();
    const apply = vi.fn(async () => true);
    const seam = {
      readText: () => "abc",
      readVersion: () => 7,
      readCanonical: () => "abc",
      build: () => ({}),
      apply,
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({ dispatch, getState: () => noStash, applyEditSeam: seam })
    );
    runEffects([{ type: "applyEdit", content: "abc", baseDocVersion: 6 }]);
    expect(apply).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: 7 },
      })
    );
  });

  it("build throws: settles constructThrew", () => {
    const dispatch = vi.fn();
    const seam = {
      readText: () => "abc",
      readVersion: () => 7,
      readCanonical: () => "",
      build: () => {
        throw new Error("boom-build");
      },
      apply: vi.fn(),
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({ dispatch, getState: () => noStash, applyEditSeam: seam })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "constructThrew" }),
      })
    );
  });

  it("apply throws synchronously: settles applyThrew", () => {
    const dispatch = vi.fn();
    const seam = {
      readText: () => "abc",
      readVersion: () => 7,
      readCanonical: () => "",
      build: () => ({}),
      apply: () => {
        throw new Error("boom-apply");
      },
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({ dispatch, getState: () => noStash, applyEditSeam: seam })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "applyThrew" }),
      })
    );
  });

  it("apply resolves true: settles ok with post-apply version", async () => {
    const dispatch = vi.fn();
    const seam = {
      readText: () => "abc",
      readVersion: () => 8,
      readCanonical: () => "",
      build: () => ({}),
      apply: async () => true,
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({ dispatch, getState: () => noStash, applyEditSeam: seam })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: 8 },
      })
    );
  });

  it("apply resolves false: settles refused", async () => {
    const dispatch = vi.fn();
    const seam = {
      readText: () => "abc",
      readVersion: () => 8,
      readCanonical: () => "",
      build: () => ({}),
      apply: async () => false,
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({ dispatch, getState: () => noStash, applyEditSeam: seam })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "refused" },
      })
    );
  });

  it("apply rejects: settles rejected, dispatch still fires post-dispose", async () => {
    const dispatch = vi.fn();
    // isDisposed flips true after apply is kicked off — pins that settlement
    // dispatches EVEN post-dispose (stash-drain safety).
    let disposed = false;
    const seam = {
      readText: () => "abc",
      readVersion: () => 8,
      readCanonical: () => "",
      build: () => ({}),
      apply: () => Promise.reject(new Error("rej")),
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({
        dispatch,
        getState: () => noStash,
        isDisposed: () => disposed,
        applyEditSeam: seam,
      })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    disposed = true;
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: expect.objectContaining({ kind: "rejected" }),
      })
    );
  });

  // error-handler C: the OK arm must ALSO dispatch post-dispose. An
  // `if (isDisposed()) return` slipped into the ok arm reintroduces the
  // last-keystroke-on-close data-loss race — this test goes red if it does.
  it("apply resolves true, disposed before callback: dispatch still fires (stash-drain safety)", async () => {
    const dispatch = vi.fn();
    let disposed = false;
    const seam = {
      readText: () => "abc",
      readVersion: () => 9,
      readCanonical: () => "",
      build: () => ({}),
      apply: async () => true,
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({
        dispatch,
        getState: () => noStash,
        isDisposed: () => disposed,
        applyEditSeam: seam,
      })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    disposed = true;
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: 9 },
      })
    );
  });

  // Codex R2-B / error-handler D: the "every arm" constraint covers refused too.
  // A guard slipped into ONLY the !ok sub-path (leaving the ok sub-path clean, so
  // the test above stays green) would strand the write lock post-dispose. This
  // pins the refused sub-path independently.
  it("apply resolves false, disposed before callback: dispatch still fires (refused, stash-drain safety)", async () => {
    const dispatch = vi.fn();
    let disposed = false;
    const seam = {
      readText: () => "abc",
      readVersion: () => 9,
      readCanonical: () => "",
      build: () => ({}),
      apply: async () => false,
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({
        dispatch,
        getState: () => noStash,
        isDisposed: () => disposed,
        applyEditSeam: seam,
      })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    disposed = true;
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "applyEditSettled",
        outcome: { kind: "refused" },
      })
    );
  });

  it("drainSnapshot reads canonical only when a stash waits", () => {
    const readCanonical = vi.fn(() => "canon");
    const seam = {
      readText: () => "abc",
      readVersion: () => 7,
      readCanonical,
      build: () => ({}),
      apply: vi.fn(async () => true),
    };
    // no-op span → settles immediately; pendingEdit null → readCanonical NOT called
    const { runEffects } = createEffectExecutor(
      makeDeps({ dispatch: vi.fn(), getState: () => noStash, applyEditSeam: seam })
    );
    runEffects([{ type: "applyEdit", content: "abc", baseDocVersion: 6 }]);
    expect(readCanonical).not.toHaveBeenCalled();
  });

  // Codex #2: the snapshot is LAZY. A stash that appears AFTER apply-start but
  // BEFORE settle must be observed at settle time (readCanonical IS called).
  // Caching pendingEdit at apply-start would make this go red.
  it("drainSnapshot reads canonical when a stash grows during the in-flight apply", async () => {
    const readCanonical = vi.fn(() => "canon");
    let stash = false;
    const seam = {
      readText: () => "abc",
      readVersion: () => 8,
      readCanonical,
      build: () => ({}),
      apply: async () => true,
    };
    const { runEffects } = createEffectExecutor(
      makeDeps({
        dispatch: vi.fn(),
        getState: () => ({ pendingEdit: stash ? {} : null }) as unknown as HostSessionState,
        applyEditSeam: seam,
      })
    );
    runEffects([{ type: "applyEdit", content: "abcd", baseDocVersion: 6 }]);
    stash = true; // stash arrives while the apply is in flight
    await Promise.resolve();
    await Promise.resolve();
    expect(readCanonical).toHaveBeenCalled();
  });
});

const rejErr = { code: "unsafe_url", message: "bad" } as const;

describe("effect-executor sendEditRejected (via postEditRejected effect)", () => {
  function runReject(over: Partial<EffectExecutorDeps> = {}) {
    const { runEffects } = createEffectExecutor(
      makeDeps({
        getState: () => ({ lastAppliedDocVersion: 3 }) as unknown as HostSessionState,
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
    expect(dispatch).toHaveBeenCalledWith({ type: "editRejectedDeliveryFailed", id: 42 });
  });

  it("reject: dispatches editRejectedDeliveryFailed(id)", async () => {
    const dispatch = vi.fn();
    runReject({ send: () => Promise.reject(new Error("x")), dispatch });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({ type: "editRejectedDeliveryFailed", id: 42 });
  });

  it("send() sync throw: dispatches editRejectedDeliveryFailed(id) synchronously", () => {
    const dispatch = vi.fn();
    runReject({
      send: () => {
        throw new Error("sync");
      },
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "editRejectedDeliveryFailed", id: 42 });
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
    expect(dispatch).toHaveBeenCalledWith({ type: "editRejectedDeliveryFailed", id: 42 });
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
          isDarkTheme: false,
        }) as HostToWebview
    );
    const { runEffects } = createEffectExecutor(makeDeps({ send, buildSeedDocument }));
    runEffects([{ type: "postDocument", docVersion: 5 }]);
    expect(buildSeedDocument).toHaveBeenCalledWith(5);
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
    runEffects([{ type: "postRejectedDraft", content: "c", docVersion: 2, error: rejErr, id: 9 }]);
    await Promise.resolve();
    await Promise.resolve();
    // document first, edit-rejected second (order is load-bearing)
    expect(calls).toEqual(["document", "edit-rejected"]);
  });

  it("postTheme: posts a theme message", () => {
    const send = vi.fn(async () => true);
    const { runEffects } = createEffectExecutor(makeDeps({ send }));
    runEffects([{ type: "postTheme", isDarkTheme: false }]);
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
    let dark = false;
    const seen: boolean[] = [];
    const send = vi.fn(async (m: HostToWebview) => {
      seen.push((m as { isDarkTheme: boolean }).isDarkTheme);
      return true;
    });
    const buildSeedDocument = (v: number): HostToWebview =>
      ({
        protocol: 1,
        type: "document",
        content: "",
        docVersion: v,
        canWrite: true,
        isDarkTheme: dark,
      }) as HostToWebview;
    const { runEffects } = createEffectExecutor(makeDeps({ send, buildSeedDocument }));
    runEffects([{ type: "postDocument", docVersion: 1 }]);
    dark = true; // theme changes AFTER the factory was built
    runEffects([{ type: "postDocument", docVersion: 2 }]);
    expect(seen).toEqual([false, true]);
  });
});
