// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlToMarkdown } from "../../../src/webview/cm/paste/html-to-markdown.js";

// Its own file because it mocks the serializer module: every inline run hits the
// repair cap. The class comes from `orig()`, because `vi.mock` is hoisted above
// this file's imports.
vi.mock("../../../src/webview/cm/paste/inline-runs.js", async (orig) => {
  const m = await orig<typeof import("../../../src/webview/cm/paste/inline-runs.js")>();
  return {
    ...m,
    serializeInlineRuns: () => {
      throw new m.InlineRepairCapExceeded();
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emphasis repair cap in the converter", () => {
  it("falls back to plain text with one content-free warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(htmlToMarkdown("<p><b>secret</b></p>")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[quoll] rich paste: emphasis repair cap exceeded");
    for (const call of warn.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain("secret");
      }
    }
  });

  it("stays silent for the other caps", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = `${"<div>".repeat(34)}<p>x</p>${"</div>".repeat(34)}`;
    expect(htmlToMarkdown(html)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
