import { describe, expect, it, vi } from "vitest";
import {
  __getActiveDocPosterForTest,
  clearActiveDocFormatPoster,
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
