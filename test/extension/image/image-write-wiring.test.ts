import { describe, expect, it, vi } from "vitest";
import { workspace } from "vscode";

import { SESSION_IMAGE_WRITE_BUDGET_TOAST } from "../../../src/extension/image/image-write-budget.js";
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

  it("enforces the per-session cumulative volume cap: writes past the budget are rejected with one warning", async () => {
    // PNG_BYTES is 8 bytes; a budget of 8 admits exactly the first write, then
    // denies every subsequent one for the life of this wiring (= the session).
    const write = vi.fn(async () => {});
    const post = vi.fn();
    const showError = vi.fn();
    const wiring = createImageWriteWiring({
      documentUri,
      canWrite: () => true,
      showError,
      post,
      writeFileOverride: () => write,
      budgetBytes: PNG_BYTES.length,
    });

    // 1st write — fits the budget exactly, written + ok:true.
    wiring.handle("req-1", PNG_BASE64);
    await flush();
    // 2nd write — over budget, rejected without touching disk, ok:false + warning.
    wiring.handle("req-2", PNG_BASE64);
    await flush();
    // 3rd write — still over budget, still rejected, but NO second warning.
    wiring.handle("req-3", PNG_BASE64);
    await flush();

    expect(write).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image-write-result", requestId: "req-1", ok: true })
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image-write-result", requestId: "req-2", ok: false })
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image-write-result", requestId: "req-3", ok: false })
    );
    // Exactly one budget warning across the two rejected writes.
    const budgetWarnings = showError.mock.calls.filter(
      ([msg]) => msg === SESSION_IMAGE_WRITE_BUDGET_TOAST
    );
    expect(budgetWarnings).toHaveLength(1);
  });

  it("scopes the budget per wiring instance: exhausting one panel's budget does not starve another", async () => {
    // Two independent wirings (= two panels/sessions). The design claims one
    // budget per panel; a regression that hoisted the budget to module scope
    // would let panel A's flood reject panel B's first write — this pins it.
    const makeWiring = () => {
      const write = vi.fn(async () => {});
      const post = vi.fn();
      const wiring = createImageWriteWiring({
        documentUri,
        canWrite: () => true,
        showError: vi.fn(),
        post,
        writeFileOverride: () => write,
        budgetBytes: PNG_BYTES.length, // admits exactly one write
      });
      return { wiring, write, post };
    };

    const a = makeWiring();
    const b = makeWiring();

    // Exhaust panel A: 1st fits, 2nd is over budget.
    a.wiring.handle("a-1", PNG_BASE64);
    a.wiring.handle("a-2", PNG_BASE64);
    await flush();
    // Panel B's FIRST write must still succeed — its budget is untouched.
    b.wiring.handle("b-1", PNG_BASE64);
    await flush();

    expect(a.write).toHaveBeenCalledOnce(); // A got exactly one write
    expect(b.write).toHaveBeenCalledOnce(); // B not starved by A's flood
    expect(b.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image-write-result", requestId: "b-1", ok: true })
    );
  });

  it("uses a generous default budget when budgetBytes is omitted (normal multi-image paste is unaffected)", async () => {
    // Omitting budgetBytes falls back to SESSION_IMAGE_WRITE_BUDGET_BYTES. A
    // handful of real (distinct) images must all write and none trip the cap or
    // warn — the Done-when "normal single/multi-image paste flows unaffected".
    const write = vi.fn(async () => {});
    const post = vi.fn();
    const showError = vi.fn();
    const wiring = createImageWriteWiring({
      documentUri,
      canWrite: () => true,
      showError,
      post,
      writeFileOverride: () => write,
      // budgetBytes omitted → real SESSION_IMAGE_WRITE_BUDGET_BYTES default.
    });

    // Distinct payloads so each content-addresses to a new file (a real paste
    // batch), all far under the 512 MiB default.
    for (let i = 0; i < 5; i++) {
      const bytes = Buffer.concat([PNG_BYTES, Buffer.from([i])]);
      wiring.handle(`req-${i}`, bytes.toString("base64"));
    }
    await flush();

    expect(write).toHaveBeenCalledTimes(5);
    const warnings = showError.mock.calls.filter(
      ([msg]) => msg === SESSION_IMAGE_WRITE_BUDGET_TOAST
    );
    expect(warnings).toHaveLength(0);
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
