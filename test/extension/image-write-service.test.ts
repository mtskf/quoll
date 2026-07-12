import { describe, expect, it, vi } from "vitest";

import { handleImageWrite } from "../../src/extension/image/image-write-service.js";
import { MAX_IMAGE_DATA_LENGTH } from "../../src/shared/protocol.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const pngBase64 = Buffer.from(PNG).toString("base64");

function makeDeps(overrides: Partial<Parameters<typeof handleImageWrite>[0]> = {}) {
  const writeImage = vi.fn(async (filename: string) => `./assets/${filename}`);
  const showError = vi.fn();
  const postResult = vi.fn();
  return {
    deps: { canWrite: () => true, writeImage, showError, postResult, ...overrides },
    writeImage,
    showError,
    postResult,
  };
}

describe("handleImageWrite", () => {
  it("writes a valid PNG and posts the relative path", async () => {
    const { deps, writeImage, postResult, showError } = makeDeps();
    await handleImageWrite(deps, "r1", pngBase64);
    expect(writeImage).toHaveBeenCalledTimes(1);
    const [filename] = writeImage.mock.calls[0];
    expect(filename).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(postResult).toHaveBeenCalledWith("r1", `./assets/${filename}`);
    expect(showError).not.toHaveBeenCalled();
  });

  it("rejects on a read-only document without writing", async () => {
    const { deps, writeImage, postResult, showError } = makeDeps({ canWrite: () => false });
    await handleImageWrite(deps, "r1", pngBase64);
    expect(writeImage).not.toHaveBeenCalled();
    expect(postResult).toHaveBeenCalledWith("r1", null);
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-image (svg) without writing", async () => {
    const { deps, writeImage, postResult } = makeDeps();
    const svg = Buffer.from("<svg></svg>").toString("base64");
    await handleImageWrite(deps, "r1", svg);
    expect(writeImage).not.toHaveBeenCalled();
    expect(postResult).toHaveBeenCalledWith("r1", null);
  });

  it("surfaces an error and posts null when writeImage rejects", async () => {
    const writeImage = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { deps, postResult, showError } = makeDeps({ writeImage });
    await handleImageWrite(deps, "r1", pngBase64);
    expect(postResult).toHaveBeenCalledWith("r1", null);
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it("rejects an over-cap data string without decoding or writing", async () => {
    const { deps, writeImage, postResult } = makeDeps();
    const huge = "a".repeat(MAX_IMAGE_DATA_LENGTH + 1);
    await handleImageWrite(deps, "r1", huge);
    expect(writeImage).not.toHaveBeenCalled();
    expect(postResult).toHaveBeenCalledWith("r1", null);
  });
});
