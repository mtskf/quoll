import { describe, expect, it } from "vitest";

import { taskCompletedContentThemeSpec } from "../../src/webview/cm/theme.js";

describe("taskCompletedContentThemeSpec — completed-content mute", () => {
  it("mutes .quoll-task-completed-content via the --quoll-completed-ink token", () => {
    const rule = taskCompletedContentThemeSpec[".quoll-task-completed-content"];
    expect(rule).toBeDefined();
    expect(rule.color).toContain("--quoll-completed-ink");
  });

  it("does NOT strike the completed content (emphasis inversion recedes, never strikes)", () => {
    const rule = taskCompletedContentThemeSpec[".quoll-task-completed-content"];
    expect(rule).not.toHaveProperty("textDecoration");
    expect(rule).not.toHaveProperty("textDecorationLine");
  });
});
