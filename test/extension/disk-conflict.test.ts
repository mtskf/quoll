import { describe, expect, it } from "vitest";
import { shouldPromptDiskConflict } from "../../src/extension/disk-conflict";

describe("shouldPromptDiskConflict", () => {
  it("does not prompt when the buffer is clean, even if disk diverges", () => {
    expect(shouldPromptDiskConflict(false, "disk\n", "buffer\n")).toBe(false);
  });

  it("does not prompt when dirty but disk equals the buffer", () => {
    expect(shouldPromptDiskConflict(true, "same\n", "same\n")).toBe(false);
  });

  it("does not prompt on an EOL-only difference (CRLF disk vs LF buffer)", () => {
    expect(shouldPromptDiskConflict(true, "a\r\nb\r\n", "a\nb\n")).toBe(false);
  });

  it("does not prompt on a BOM-only difference (BOM on disk, none in buffer)", () => {
    // VS Code strips a leading BOM on load, so disk bytes decoded with a BOM
    // must not read as a content conflict against the BOM-less buffer. The BOM
    // is built from its code point so no invisible glyph lives in the test.
    const bom = String.fromCharCode(0xfeff);
    expect(shouldPromptDiskConflict(true, `${bom}a\nb\n`, "a\nb\n")).toBe(false);
  });

  it("prompts when dirty and disk content genuinely diverges", () => {
    expect(shouldPromptDiskConflict(true, "## External\n\nbody\n", "body\n")).toBe(true);
  });
});
