import { describe, expect, it } from "vitest";

import { decideImageWrite, sniffImageKind } from "../../../src/extension/image/image-ingest.js";
import { MAX_IMAGE_BYTES } from "../../../src/shared/protocol.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF89 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]); // "GIF89a"
const GIF87 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]); // "GIF87a"
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]); // "RIFF"+size+"WEBP"+"VP8 "
const SVG = new Uint8Array([...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')]);

describe("sniffImageKind", () => {
  it("recognises the four allowlisted raster types", () => {
    expect(sniffImageKind(PNG)).toBe("png");
    expect(sniffImageKind(JPEG)).toBe("jpeg");
    expect(sniffImageKind(GIF89)).toBe("gif");
    expect(sniffImageKind(GIF87)).toBe("gif");
    expect(sniffImageKind(WEBP)).toBe("webp");
  });

  it("rejects SVG, text, truncated and malformed headers", () => {
    expect(sniffImageKind(SVG)).toBeNull();
    expect(sniffImageKind(new Uint8Array([0x68, 0x69]))).toBeNull();
    expect(sniffImageKind(new Uint8Array([0x89, 0x50]))).toBeNull(); // truncated PNG
    expect(sniffImageKind(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x30, 0x61]))).toBeNull(); // "GIF80a" bad version
    // RIFF without WEBP/chunk marker → not webp
    expect(
      sniffImageKind(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    ).toBeNull();
    // RIFF+WEBP but bad chunk fourCC
    expect(
      sniffImageKind(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x58, 0x58, 0x58, 0x58,
        ])
      )
    ).toBeNull();
  });

  it("sniffs by leading magic only — a PNG-magic polyglot with trailing SVG bytes is png", () => {
    // Sniffing is prefix-based: the first 8 bytes are the PNG signature, so a
    // polyglot that appends `<svg …>` (or any script payload) AFTER a valid
    // PNG header is classified png. Trailing bytes never change the verdict.
    const polyglot = new Uint8Array([...PNG, ...SVG]);
    expect(sniffImageKind(polyglot)).toBe("png");
  });
});

describe("decideImageWrite", () => {
  it("rejects with reason 'readonly' when canWrite is false — even for a valid PNG", () => {
    expect(decideImageWrite(false, PNG)).toEqual({ kind: "reject", reason: "readonly" });
  });

  it("rejects empty input", () => {
    expect(decideImageWrite(true, new Uint8Array([]))).toEqual({ kind: "reject", reason: "empty" });
  });

  it("rejects input over the byte cap", () => {
    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1);
    tooBig.set(PNG, 0);
    expect(decideImageWrite(true, tooBig)).toEqual({ kind: "reject", reason: "too-large" });
  });

  it("rejects a non-allowlisted type (SVG)", () => {
    expect(decideImageWrite(true, SVG)).toEqual({ kind: "reject", reason: "unsupported-type" });
  });

  it("writes with a full SHA-256 content-hashed filename + sniffed extension", () => {
    const d = decideImageWrite(true, PNG);
    expect(d.kind).toBe("write");
    if (d.kind === "write") {
      expect(d.filename).toMatch(/^[0-9a-f]{64}\.png$/);
      expect(d.bytes).toBe(PNG);
    }
  });

  it("derives the extension from sniffed bytes for each type", () => {
    expect((decideImageWrite(true, JPEG) as { filename: string }).filename).toMatch(/\.jpg$/);
    expect((decideImageWrite(true, GIF89) as { filename: string }).filename).toMatch(/\.gif$/);
    expect((decideImageWrite(true, WEBP) as { filename: string }).filename).toMatch(/\.webp$/);
  });

  it("accepts a PNG-magic polyglot and writes the full bytes verbatim (trailing payload included)", () => {
    // A polyglot (valid PNG header + trailing SVG/script bytes) passes the type
    // gate on its leading magic. The decision writes the ENTIRE byte sequence —
    // the trailing payload is NOT stripped — under a content hash of those full
    // bytes, so it never collides with the plain-PNG name. This pins that
    // prefix-sniffing is the whole type defense; sanitising embedded trailing
    // content is out of scope (raster bytes are inert as an <img> src — the
    // file is served, never executed).
    const polyglot = new Uint8Array([...PNG, ...SVG]);
    const d = decideImageWrite(true, polyglot);
    expect(d.kind).toBe("write");
    if (d.kind === "write") {
      expect(d.filename).toMatch(/^[0-9a-f]{64}\.png$/);
      expect(d.bytes).toBe(polyglot);
      const plain = decideImageWrite(true, PNG);
      if (plain.kind === "write") {
        expect(d.filename).not.toBe(plain.filename);
      }
    }
  });

  it("is content-addressed: same bytes → same name, different bytes → different name", () => {
    const a = decideImageWrite(true, PNG) as { filename: string };
    const b = decideImageWrite(true, PNG) as { filename: string };
    const c = decideImageWrite(true, new Uint8Array([...PNG, 0xff])) as { filename: string };
    expect(a.filename).toBe(b.filename);
    expect(a.filename).not.toBe(c.filename);
  });
});
