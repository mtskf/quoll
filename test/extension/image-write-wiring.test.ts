import { describe, expect, it, vi } from "vitest";

import { createImageWriteWiring } from "../../src/extension/image-write-wiring.js";

// A minimal valid PNG (8-byte signature) — decideImageWrite sniffs the magic
// bytes and content-addresses the filename as <sha256>.png.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = PNG_BYTES.toString("base64");

// Flush the microtask queue so the fire-and-forget `void handleImageWrite(...)`
// promise settles before assertions.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const documentUri = { scheme: "file", toString: () => "file:///doc.md" } as never;

describe("createImageWriteWiring", () => {
  it("rejects on a read-only document without invoking the write override", async () => {
    const write = vi.fn(async () => {});
    const post = vi.fn();
    const showError = vi.fn();
    const wiring = createImageWriteWiring({
      documentUri,
      canWrite: () => false,
      showError,
      post,
      writeFileOverride: () => write,
    });

    wiring.handle("req-ro", PNG_BASE64);
    await flush();

    expect(write).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledOnce();
    // ok:false result posted so the webview clears its pending entry.
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image-write-result", requestId: "req-ro", ok: false })
    );
  });

  it("writes under ./assets/ and posts the content-addressed relative path", async () => {
    const write = vi.fn(async () => {});
    const post = vi.fn();
    const wiring = createImageWriteWiring({
      documentUri,
      canWrite: () => true,
      showError: vi.fn(),
      post,
      writeFileOverride: () => write,
    });

    wiring.handle("req-ok", PNG_BASE64);
    await flush();

    expect(write).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image-write-result",
        requestId: "req-ok",
        ok: true,
        relativePath: expect.stringMatching(/^\.\/assets\/[0-9a-f]{64}\.png$/),
      })
    );
  });
});
