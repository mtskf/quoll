import { afterEach, describe, expect, it, vi } from "vitest";
import { window } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts
import {
  __getActiveDocPosterForTest,
  clearActiveDocFormatPoster,
  runFormatDocumentCommand,
  setActiveDocFormatPoster,
} from "../../../src/extension/commands/format-document-command.js";

describe("doc-format active poster", () => {
  it("set/get + identity-guarded clear", () => {
    const a = vi.fn();
    const b = vi.fn();
    setActiveDocFormatPoster(a);
    setActiveDocFormatPoster(b);
    clearActiveDocFormatPoster(a);
    expect(__getActiveDocPosterForTest()).toBe(b);
    clearActiveDocFormatPoster(b);
    expect(__getActiveDocPosterForTest()).toBeNull();
  });
});

describe("runFormatDocumentCommand — the arm that used to be silent", () => {
  afterEach(() => {
    const active = __getActiveDocPosterForTest();
    if (active !== null) {
      clearActiveDocFormatPoster(active);
    }
    vi.restoreAllMocks();
  });

  it("forwards to the active panel without a toast", () => {
    const post = vi.fn();
    setActiveDocFormatPoster(post);
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatDocumentCommand();

    expect(post).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it("explains itself when no Quoll panel is active", () => {
    // Palette-only command: invoking it from a text editor (or with no editor
    // at all) used to be `registry.get()?.()` — a silent no-op.
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatDocumentCommand();

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/Quoll/);
  });
});
