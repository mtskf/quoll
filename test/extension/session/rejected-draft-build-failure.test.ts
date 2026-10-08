// @vitest-environment node
//
// `buildRejectedDraft` is the one injected builder besides `buildSeedDocument`
// that reads LIVE state (the panel wires it to `window.activeColorTheme.kind`
// and `workspace.fs.isWritableFileSystem`), so a throw from it must not unwind
// `runEffects`. These tests drive the REAL reducer into the two lists that
// carry a `postRejectedDraft` — the drain's parse-failed arm and the `ready`
// replay — through the real executor, and pin what containment does and does
// not do: the tail of the list still runs and nothing escapes, while the arm
// itself sends and dispatches NOTHING. No recovery is claimed: the rejection
// stays pending, exactly as it did when the throw escaped.
import { describe, expect, it, vi } from "vitest";

import { createEffectExecutor } from "../../../src/extension/session/effect-executor.js";
import {
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEvent,
  type HostSessionState,
} from "../../../src/extension/session/host-session-core.js";
import type { MarkdownError } from "../../../src/markdown/errors.js";
import type { ValidateForWriteResult } from "../../../src/markdown/validate-for-write.js";
import { type HostToWebview, PROTOCOL_VERSION } from "../../../src/shared/protocol.js";

const ctx = { uriString: "file:///x.md", fsPath: "/x.md" };
const unsafe: MarkdownError = {
  code: "unsafe_url",
  message: "URL is not in the allowlist: javascript:alert(1)",
};
const validateForWrite = (content: string): ValidateForWriteResult =>
  content.includes("BAD") ? { ok: false, error: unsafe } : { ok: true };

function harness(initial: (seed: HostSessionState) => HostSessionState) {
  const core = createHostSessionCore(ctx, { validateForWrite });
  const sent: HostToWebview[] = [];
  const toasts: string[] = [];
  const dispatched: HostSessionEvent["type"][] = [];
  let live = initial(core.initialState(1));

  const dispatch = createDrainingDispatcher((event: HostSessionEvent) => {
    dispatched.push(event.type);
    const r = core.transition(live, event);
    live = r.state;
    executor.runEffects(r.effects);
  });

  const unreachable = (name: string) => () => {
    throw new Error(`${name} must not be reached`);
  };
  const executor = createEffectExecutor({
    isDisposed: () => false,
    getState: () => live,
    uriString: () => ctx.uriString,
    dispatch,
    send: async (message) => {
      sent.push(message);
      return true;
    },
    recordEvent: () => {},
    showError: (message) => {
      toasts.push(message);
    },
    canWrite: () => true,
    readLineageSince: () => null,
    buildSeedDocument: unreachable("buildSeedDocument"),
    buildRejectedDraft: () => {
      throw new Error("boom-draft");
    },
    buildTheme: (themeKind) => ({ protocol: PROTOCOL_VERSION, type: "theme", themeKind }),
    buildEditRejected: (error) => ({ protocol: PROTOCOL_VERSION, type: "edit-rejected", error }),
    applyEditSeam: {
      readText: unreachable("readText"),
      readVersion: () => 1,
      readCanonical: unreachable("readCanonical"),
      canonicalize: (text) => text,
      build: unreachable("build"),
      apply: unreachable("apply"),
    },
    openExternal: unreachable("openExternal"),
  });

  return { dispatch, sent, toasts, dispatched, state: () => live };
}

// Lets a (wrongly) attempted `send` settle, so a failure-aware delivery would
// have had its chance to dispatch before the "nothing was sent" assertions.
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

describe("a throwing buildRejectedDraft is contained", () => {
  it("drain parse-failed list: the trailing `Cannot save:` toast still runs; the arm sends and dispatches nothing; the rejection stays pending", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness((seed) => ({
        ...seed,
        pendingApplyBaseVersion: 1,
        inFlightContent: "edit1",
        pendingEdit: { content: "hasBAD", baseDocVersion: 1 },
      }));

      expect(() =>
        h.dispatch({
          type: "applyEditSettled",
          outcome: { kind: "ok" },
          settledVersion: 2,
          canWrite: true,
          currentContent: "edit1",
          preApplyContent: "edit1",
        })
      ).not.toThrow();
      await flush();

      expect(h.toasts).toEqual([`Cannot save: ${unsafe.message}`]);
      expect(h.sent).toEqual([]);
      expect(h.dispatched).toEqual(["applyEditSettled"]);
      expect(h.state().rejection).toMatchObject({ kind: "pending", content: "hasBAD" });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to build the rejected draft"),
        expect.any(Error)
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The panel's `ready` handler runs `editorConfig.push()` right AFTER this
  // dispatch, in the same synchronous frame (`quoll-editor-panel.ts`), so an
  // escaping throw is what used to cost a ready webview its `editor-config`.
  // The executor has no editor-config seam; a push written the way the panel
  // writes it stands in for it.
  it("`ready` replay list: the throw does not escape the dispatch, so the editor-config push after it still happens", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness((seed) => ({
        ...seed,
        rejection: { kind: "pending", id: 1, content: "hasBAD", error: unsafe },
        nextRejectionId: 2,
      }));
      const editorConfigPush = vi.fn();

      expect(() => {
        h.dispatch({ type: "ready", documentVersion: 1, lineageSince: null });
        editorConfigPush();
      }).not.toThrow();
      await flush();

      expect(editorConfigPush).toHaveBeenCalledOnce();
      expect(h.sent).toEqual([]);
      expect(h.dispatched).toEqual(["ready"]);
      expect(h.state().rejection).toMatchObject({ kind: "pending", content: "hasBAD" });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
