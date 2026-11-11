import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActivePanelPost,
  getActivePanelPost,
  setActivePanelPost,
} from "../../../src/extension/commands/active-panel.js";

describe("active panel post", () => {
  afterEach(() => {
    const active = getActivePanelPost();
    if (active !== null) {
      clearActivePanelPost(active);
    }
  });

  it("set then get returns the post", () => {
    const post = vi.fn();
    setActivePanelPost(post);
    expect(getActivePanelPost()).toBe(post);
  });
  it("clear with the same identity removes the post", () => {
    const post = vi.fn();
    setActivePanelPost(post);
    clearActivePanelPost(post);
    expect(getActivePanelPost()).toBeNull();
  });
  it("identity-guarded clear does not wipe a newer post", () => {
    const a = vi.fn();
    const b = vi.fn();
    setActivePanelPost(a);
    setActivePanelPost(b);
    clearActivePanelPost(a); // stale clear
    expect(getActivePanelPost()).toBe(b);
    clearActivePanelPost(b);
    expect(getActivePanelPost()).toBeNull();
  });
});
