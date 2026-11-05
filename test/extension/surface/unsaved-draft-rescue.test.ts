import { afterEach, describe, expect, it, vi } from "vitest";
import { rescueUnsavedDraft } from "../../../src/extension/surface/unsaved-draft-rescue.js";

const draft = { content: "original\r\nbytes", reason: "bad link!" };
const path = "/ws/notes.md";
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const setup = (
  openUntitled: (content: string) => PromiseLike<unknown> = () => Promise.resolve()
) => {
  const order: string[] = [];
  const warning = vi.fn(() => {
    order.push("warning");
  });
  const error = vi.fn(() => {
    order.push("error");
  });
  const open = vi.fn((content: string) => {
    order.push("open");
    expect(warning).toHaveBeenCalledOnce();
    return openUntitled(content);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    order,
    warning,
    error,
    open,
    log,
    deps: { openUntitled: open, showWarning: warning, showError: error },
  };
};
afterEach(() => vi.restoreAllMocks());
describe("rescueUnsavedDraft", () => {
  it("warns before opening, preserving bytes and punctuation", async () => {
    const s = setup();
    rescueUnsavedDraft(draft, path, s.deps);
    expect(s.order).toEqual(["warning", "open"]);
    expect(s.open).toHaveBeenCalledWith(draft.content);
    expect(s.warning).toHaveBeenCalledWith(
      `Quoll could not save an edit to ${path}. Opening the unsaved draft in a new untitled document. Reason: bad link!`
    );
    await flush();
    expect(s.error).not.toHaveBeenCalled();
  });
  it("leaves the warning visible for an open that never settles", async () => {
    const s = setup(() => new Promise(() => undefined));
    rescueUnsavedDraft(draft, path, s.deps);
    await flush();
    expect(s.order).toEqual(["warning", "open"]);
  });
  it.each([
    "reject",
    "throw",
    "getter",
    "thenable",
  ])("logs original bytes and reports %s open failure", async (kind) => {
    const cause = new Error(kind);
    const s = setup(() => {
      if (kind === "throw") {
        throw cause;
      }
      if (kind === "getter") {
        // biome-ignore lint/suspicious/noThenProperty: deliberately exercises a throwing Thenable getter.
        return Object.defineProperty({}, "then", {
          get() {
            throw cause;
          },
        }) as PromiseLike<unknown>;
      }
      if (kind === "thenable") {
        return {
          // biome-ignore lint/suspicious/noThenProperty: deliberately exercises a rejecting Thenable.
          then(_resolve, reject) {
            reject?.(cause);
          },
        } as PromiseLike<unknown>;
      }
      return Promise.reject(cause);
    });
    expect(() => rescueUnsavedDraft(draft, path, s.deps)).not.toThrow();
    await flush();
    expect(s.order).toEqual(["warning", "open", "error"]);
    expect(s.log).toHaveBeenCalledWith(
      "[quoll] could not open unsaved draft",
      cause,
      draft.content
    );
    expect(s.error).toHaveBeenCalledWith(
      `Quoll could not open the unsaved draft for ${path}. Copy it from the log: the draft content was logged to the extension host console.`
    );
  });
  it("reports a logging failure with the fallback message", async () => {
    const s = setup(() => Promise.reject(new Error("open")));
    s.log.mockImplementation(() => {
      throw new Error("log");
    });
    rescueUnsavedDraft(draft, path, s.deps);
    await flush();
    expect(s.error).toHaveBeenCalledWith(
      `Quoll could not open the unsaved draft for ${path}, and could not write its content to the extension host console.`
    );
  });
  it("contains rejecting notifications and a throwing reporter without an unhandled rejection", async () => {
    const s = setup();
    s.deps.showWarning.mockImplementation(() => Promise.reject(new Error("notification")) as never);
    s.log.mockImplementation(() => {
      throw new Error("reporter");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(() => rescueUnsavedDraft(draft, path, s.deps)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(s.log).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
  it("contains a synchronous warning failure and still opens the original bytes", () => {
    const s = setup();
    s.warning.mockImplementation(() => {
      throw new Error("warning");
    });
    expect(() => rescueUnsavedDraft(draft, path, s.deps)).not.toThrow();
    expect(s.open).toHaveBeenCalledWith(draft.content);
    expect(s.log).toHaveBeenCalledTimes(1);
    expect(s.error).not.toHaveBeenCalled();
  });

  it("contains an error notification failure after an open failure", async () => {
    const s = setup(() => Promise.reject(new Error("open")));
    s.error.mockImplementation(() => {
      throw new Error("error notice");
    });
    expect(() => rescueUnsavedDraft(draft, path, s.deps)).not.toThrow();
    await flush();
    expect(s.warning).toHaveBeenCalledOnce();
    expect(s.error).toHaveBeenCalledOnce();
    expect(s.log).toHaveBeenCalledTimes(2);
  });
});
