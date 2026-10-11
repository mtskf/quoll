import { afterEach, describe, expect, it, vi } from "vitest";
import type { RejectionState } from "../../../src/extension/session/host-session-core.js";
import { rescueRejectedDraft } from "../../../src/extension/surface/rejected-draft-rescue.js";

const FS_PATH = "/ws/notes.md";

const none: RejectionState = { kind: "none" };
const pending: RejectionState = {
  kind: "pending",
  id: 1,
  content: "draft",
  error: { code: "unsafe_url", message: "bad link" },
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const setup = (
  openUntitled: (content: string) => Thenable<unknown> = () => Promise.resolve(undefined),
  showWarning: (message: string) => void = () => undefined
) => {
  const open = vi.fn(openUntitled);
  const warn = vi.fn(showWarning);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return { open, warn, errorSpy, deps: { openUntitled: open, showWarning: warn } };
};

const captureUnhandled = () => {
  const spy = vi.fn();
  process.on("unhandledRejection", spy);
  return { spy, remove: () => process.off("unhandledRejection", spy) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rescueRejectedDraft", () => {
  it("does nothing when no rejection is pending", () => {
    const { open, warn, deps } = setup();
    rescueRejectedDraft(none, FS_PATH, deps);
    expect(open).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("opens the draft and warns once after the open fulfils", async () => {
    const { open, warn, deps } = setup();
    rescueRejectedDraft(pending, FS_PATH, deps);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("draft");
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain(FS_PATH);
    expect(message).toContain("bad link");
    expect(message).toContain("untitled document");
  });

  it("does not warn before openUntitled settles", () => {
    const { warn, deps } = setup(() => new Promise(() => undefined));
    rescueRejectedDraft(pending, FS_PATH, deps);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns that the draft could not be reopened when openUntitled rejects", async () => {
    const { warn, errorSpy, deps } = setup(() => Promise.reject(new Error("boom")));
    rescueRejectedDraft(pending, FS_PATH, deps);
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("could not reopen");
    expect(message).toContain(FS_PATH);
    expect(message).toContain("bad link");
    expect(message).not.toContain("lost");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("treats a synchronous throw from openUntitled like a rejection", () => {
    const { warn, errorSpy, deps } = setup(() => {
      throw new Error("sync boom");
    });
    expect(() => rescueRejectedDraft(pending, FS_PATH, deps)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] as string;
    expect(message).toContain("could not reopen");
    expect(message).not.toContain("lost");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("success message never claims the draft is lost", async () => {
    const { warn, deps } = setup();
    rescueRejectedDraft(pending, FS_PATH, deps);
    await flush();
    expect(warn.mock.calls[0]?.[0] as string).not.toContain("lost");
  });

  it("a throwing showWarning after a successful open is logged, not re-notified", async () => {
    const { warn, errorSpy, deps } = setup(undefined, () => {
      throw new Error("toast failed");
    });
    const unhandled = captureUnhandled();
    try {
      rescueRejectedDraft(pending, FS_PATH, deps);
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(unhandled.spy).not.toHaveBeenCalled();
    } finally {
      unhandled.remove();
    }
  });

  it("a throwing showWarning after a failed open is notified once and does not leak", async () => {
    const { warn, errorSpy, deps } = setup(
      () => Promise.reject(new Error("boom")),
      () => {
        throw new Error("toast failed");
      }
    );
    const unhandled = captureUnhandled();
    try {
      rescueRejectedDraft(pending, FS_PATH, deps);
      await new Promise((r) => setTimeout(r, 0));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(unhandled.spy).not.toHaveBeenCalled();
    } finally {
      unhandled.remove();
    }
  });
});
