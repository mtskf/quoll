import { describe, expect, it } from "vitest";
import {
  isRejectionPending,
  registerPendingRejection,
} from "../../../src/extension/surface/rejection-registry.js";

const URI = "file:///doc.md";

describe("rejection-registry", () => {
  it("reads false for an unregistered uri (swap unblocked by default)", () => {
    expect(isRejectionPending("file:///never-registered.md")).toBe(false);
  });

  it("reflects the live predicate value for a registered uri", () => {
    let pending = false;
    const reg = registerPendingRejection(URI, () => pending);
    try {
      expect(isRejectionPending(URI)).toBe(false);
      pending = true;
      expect(isRejectionPending(URI)).toBe(true);
      pending = false;
      expect(isRejectionPending(URI)).toBe(false);
    } finally {
      reg.dispose();
    }
  });

  it("returns false after the registration is disposed", () => {
    const reg = registerPendingRejection(URI, () => true);
    expect(isRejectionPending(URI)).toBe(true);
    reg.dispose();
    expect(isRejectionPending(URI)).toBe(false);
  });

  it("is identity-safe: disposing a stale registration does not delete the live one", () => {
    // Models a panel re-resolve on the same uri: the OLD panel registers, the NEW
    // panel registers (overwriting), then the OLD panel's dispose fires. The live
    // (new) predicate must survive the stale dispose.
    const oldReg = registerPendingRejection(URI, () => false);
    const newReg = registerPendingRejection(URI, () => true);
    try {
      expect(isRejectionPending(URI)).toBe(true); // new predicate wins
      oldReg.dispose(); // stale dispose must be a no-op
      expect(isRejectionPending(URI)).toBe(true); // new predicate survived
    } finally {
      newReg.dispose();
    }
    expect(isRejectionPending(URI)).toBe(false);
  });
});
