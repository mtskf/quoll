import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRootUrl = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", repoRootUrl), "utf8"));

describe("package.json contributions — quoll.gettingStarted walkthrough", () => {
  const walkthrough = (pkg.contributes.walkthroughs ?? []).find(
    (w: { id: string }) => w.id === "quoll.gettingStarted"
  );

  it("declares the getting-started walkthrough with exactly 5 steps", () => {
    expect(walkthrough).toBeDefined();
    expect(walkthrough.steps).toHaveLength(5);
    expect(walkthrough.steps.map((s: { id: string }) => s.id)).toEqual([
      "openInQuoll",
      "caretReveal",
      "toggleEditor",
      "outline",
      "lintSettings",
    ]);
  });

  it("only references onCommand completion events for commands declared in contributes.commands", () => {
    const declaredCommandIds = new Set(
      pkg.contributes.commands.map((c: { command: string }) => c.command)
    );
    const onCommandEvents = walkthrough.steps.flatMap((s: { completionEvents?: string[] }) =>
      (s.completionEvents ?? []).filter((e: string) => e.startsWith("onCommand:"))
    );
    // The regression guard: both command-driven steps must be present, and
    // each referenced id must still exist in contributes.commands.
    expect(onCommandEvents).toEqual(
      expect.arrayContaining(["onCommand:quoll.editWith", "onCommand:quoll.toggleEditor"])
    );
    for (const event of onCommandEvents) {
      const commandId = event.slice("onCommand:".length);
      expect(declaredCommandIds.has(commandId)).toBe(true);
    }
  });

  it("points every step's media.markdown at a file that exists on disk", () => {
    expect(walkthrough.steps).toHaveLength(5);
    for (const step of walkthrough.steps) {
      const mediaPath = step.media?.markdown;
      expect(typeof mediaPath).toBe("string");
      const absolutePath = fileURLToPath(new URL(mediaPath, repoRootUrl));
      expect(existsSync(absolutePath)).toBe(true);
    }
  });
});
