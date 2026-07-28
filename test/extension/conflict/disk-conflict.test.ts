import { describe, expect, it } from "vitest";
import {
  decodeComparableUtf8,
  shouldPromptDiskConflict,
} from "../../../src/extension/conflict/disk-conflict";

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

describe("decodeComparableUtf8", () => {
  const enc = new TextEncoder();

  it("decodes valid UTF-8 (ASCII) to the same text", () => {
    expect(decodeComparableUtf8(enc.encode("hello\nworld\n"))).toBe("hello\nworld\n");
  });

  it("decodes valid multi-byte UTF-8 (Japanese) faithfully", () => {
    expect(decodeComparableUtf8(enc.encode("# 見出し\n本文\n"))).toBe("# 見出し\n本文\n");
  });

  it("strips a leading UTF-8 BOM (TextDecoder default), matching load-time normalization", () => {
    // EF BB BF = UTF-8 BOM, then 'a'. Decoded output drops the BOM.
    expect(decodeComparableUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
  });

  it("returns null for invalid UTF-8 (a UTF-16 BOM prefix)", () => {
    // FF FE is a UTF-16LE BOM: 0xFF is not a valid UTF-8 start byte.
    expect(decodeComparableUtf8(Uint8Array.from([0xff, 0xfe, 0x00, 0x41]))).toBeNull();
  });

  it("returns null for a lone UTF-8 continuation byte (Shift-JIS-like garbage)", () => {
    expect(decodeComparableUtf8(Uint8Array.from([0x80]))).toBeNull();
  });

  it("returns null when the decoded text contains a NUL (BOM-less UTF-16 of ASCII)", () => {
    // 41 00 42 = 'A', NUL, 'B' — all valid single UTF-8 bytes, but the NUL
    // betrays a non-UTF-8 text encoding read byte-wise.
    expect(decodeComparableUtf8(Uint8Array.from([0x41, 0x00, 0x42]))).toBeNull();
  });

  it("returns empty string for empty bytes (a real, comparable empty file)", () => {
    expect(decodeComparableUtf8(new Uint8Array(0))).toBe("");
  });
});
