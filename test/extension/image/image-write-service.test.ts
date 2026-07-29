import { describe, expect, it, vi } from "vitest";

import { handleImageWrite } from "../../../src/extension/image/image-write-service.js";
import { MAX_IMAGE_DATA_LENGTH } from "../../../src/shared/protocol.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const pngBase64 = Buffer.from(PNG).toString("base64");

// An all-permitting budget stub — the default so tests that don't exercise the
// cap read cleanly. Tests that care pass a spy via `overrides.budget`.
const unboundedBudget = () => ({ reserve: vi.fn(() => true), release: vi.fn() });

function makeDeps(overrides: Partial<Parameters<typeof handleImageWrite>[0]> = {}) {
  const writeImage = vi.fn(async (filename: string) => `./assets/${filename}`);
  const showError = vi.fn();
  const postResult = vi.fn();
  return {
    deps: {
      canWrite: () => true,
      writeImage,
      showError,
      postResult,
      budget: unboundedBudget(),
      ...overrides,
    },
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

  it("rejects on a read-only document without writing OR charging the budget", async () => {
    const budget = unboundedBudget();
    const { deps, writeImage, postResult, showError } = makeDeps({
      canWrite: () => false,
      budget,
    });
    await handleImageWrite(deps, "r1", pngBase64);
    expect(writeImage).not.toHaveBeenCalled();
    expect(postResult).toHaveBeenCalledWith("r1", null);
    expect(showError).toHaveBeenCalledTimes(1);
    // The read-only guard precedes (and short-circuits) the budget charge — pins
    // that ordering so a future reorder that charges before the guard is caught.
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("rejects a non-image (svg) without writing OR charging the budget", async () => {
    const budget = unboundedBudget();
    const { deps, writeImage, postResult } = makeDeps({ budget });
    const svg = Buffer.from("<svg></svg>").toString("base64");
    await handleImageWrite(deps, "r1", svg);
    expect(writeImage).not.toHaveBeenCalled();
    expect(postResult).toHaveBeenCalledWith("r1", null);
    // A per-message-cap rejection (unsupported type) must skip the budget entirely.
    expect(budget.reserve).not.toHaveBeenCalled();
  });

  it("surfaces an error, posts null, AND refunds the budget when writeImage rejects", async () => {
    const writeImage = vi.fn(async () => {
      throw new Error("disk full");
    });
    const budget = unboundedBudget();
    const { deps, postResult, showError } = makeDeps({ writeImage, budget });
    await handleImageWrite(deps, "r1", pngBase64);
    expect(postResult).toHaveBeenCalledWith("r1", null);
    expect(showError).toHaveBeenCalledTimes(1);
    // A failed write reached no disk, so its reservation is released — otherwise
    // a run of transient FS failures would exhaust the session cap.
    expect(budget.reserve).toHaveBeenCalledWith(PNG.length);
    expect(budget.release).toHaveBeenCalledWith(PNG.length);
  });

  it("rejects an over-cap data string without decoding or writing", async () => {
    const { deps, writeImage, postResult } = makeDeps();
    const huge = "a".repeat(MAX_IMAGE_DATA_LENGTH + 1);
    await handleImageWrite(deps, "r1", huge);
    expect(writeImage).not.toHaveBeenCalled();
    expect(postResult).toHaveBeenCalledWith("r1", null);
  });

  it("rejects a validated write when the session budget denies it (no showError — the budget warns)", async () => {
    const budget = { reserve: vi.fn(() => false), release: vi.fn() };
    const { deps, writeImage, postResult, showError } = makeDeps({ budget });
    await handleImageWrite(deps, "r1", pngBase64);
    // The image passed every per-message gate — the budget is charged with the
    // validated byte length, and only then does it deny the write.
    expect(budget.reserve).toHaveBeenCalledWith(PNG.length);
    expect(writeImage).not.toHaveBeenCalled();
    expect(postResult).toHaveBeenCalledWith("r1", null);
    // A denied reservation was never charged, so nothing to release.
    expect(budget.release).not.toHaveBeenCalled();
    // The budget owns its one-time warning; the service must NOT toast here.
    expect(showError).not.toHaveBeenCalled();
  });

  it("writes normally when the session budget allows it (and does not release on success)", async () => {
    const budget = { reserve: vi.fn(() => true), release: vi.fn() };
    const { deps, writeImage, postResult } = makeDeps({ budget });
    await handleImageWrite(deps, "r1", pngBase64);
    expect(budget.reserve).toHaveBeenCalledWith(PNG.length);
    expect(writeImage).toHaveBeenCalledTimes(1);
    const [filename] = writeImage.mock.calls[0];
    expect(postResult).toHaveBeenCalledWith("r1", `./assets/${filename}`);
    // A successful write keeps its charge — no refund.
    expect(budget.release).not.toHaveBeenCalled();
  });
});
