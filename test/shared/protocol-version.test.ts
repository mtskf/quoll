import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION as PROD_VERSION } from "../../src/shared/protocol";
import { PROTOCOL_VERSION as TEST_VERSION } from "../extension/e2e/constants";

describe("PROTOCOL_VERSION mirror", () => {
  it("test-side constant matches the production protocol version", () => {
    // Pin: when production bumps PROTOCOL_VERSION for a wire change,
    // the test mirror MUST move with it. This guard fails loudly so
    // the E2E suite cannot silently send protocol: 1 messages after
    // the host moved to protocol: 2.
    expect(TEST_VERSION).toBe(PROD_VERSION);
  });
});
