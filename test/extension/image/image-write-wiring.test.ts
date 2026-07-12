import { describe, expect, it, vi } from "vitest";
import { workspace } from "vscode";

import { createImageWriteWiring } from "../../../src/extension/image/image-write-wiring.js";

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

  it("creates the assets dir BEFORE writing, then posts the content-addressed path", async () => {
    // Spy on the stub's createDirectory so we can assert it ran (the impl calls it
    // to avoid depending on writeFile's undocumented parent-dir behaviour) AND that
    // it ran before the write — reverting the createDirectory line in the wiring
    // makes this test red.
    const createDirSpy = vi.spyOn(workspace.fs, "createDirectory");
    createDirSpy.mockClear();
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

    expect(createDirSpy).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    // Ordering: createDirectory must be invoked before the write override.
    expect(createDirSpy.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0]
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "image-write-result",
        requestId: "req-ok",
        ok: true,
        relativePath: expect.stringMatching(/^\.\/assets\/[0-9a-f]{64}\.png$/),
      })
    );

    createDirSpy.mockRestore();
  });

  it("re-reads writeFileOverride per call (late-bound override, not captured at construction)", async () => {
    // The wiring reads deps.writeFileOverride() fresh inside the write closure on
    // every handle() — the e2e harness sets writeImageFileOverride AFTER the panel
    // (and thus the wiring) is constructed. A regression to eager, construct-time
    // resolution would capture the null below and this test would go red.
    const post = vi.fn();
    let currentOverride: ((uri: unknown, content: Uint8Array) => Thenable<void>) | null = null;
    const wiring = createImageWriteWiring({
      documentUri,
      canWrite: () => true,
      showError: vi.fn(),
      post,
      writeFileOverride: () => currentOverride as never,
    });

    const write = vi.fn(async () => {});
    currentOverride = write; // set AFTER the wiring object is built

    wiring.handle("req-late", PNG_BASE64);
    await flush();

    expect(write).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image-write-result", requestId: "req-late", ok: true })
    );
  });
});
