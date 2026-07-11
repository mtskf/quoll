import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRootUrl = new URL("../../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", repoRootUrl), "utf8"));

// Built-in VS Code commands referenced by walkthrough markdown that are never
// declared in this extension's own contributes.commands.
const builtinCommandAllowlist = new Set(["outline.focus", "workbench.action.openSettings"]);

function extractCommandUris(markdown: string): string[] {
  const matches = markdown.matchAll(/\(command:([^)?]+)(?:\?[^)]*)?\)/g);
  return Array.from(matches, (m) => m[1]);
}

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

  it("wires no onCommand completion events", () => {
    const onCommandEvents = walkthrough.steps.flatMap((s: { completionEvents?: string[] }) =>
      (s.completionEvents ?? []).filter((e: string) => e.startsWith("onCommand:"))
    );
    // openInQuoll (quoll.editWith) and toggleEditor (quoll.toggleEditor) deliberately
    // do NOT wire onCommand completion events: both commands can no-op (no active
    // editor / active tab is neither Quoll nor a markdown text editor) — most likely
    // exactly while the user is looking at this walkthrough page — which would mark
    // the step done without anything having happened. Users mark these steps done
    // manually instead (same pattern as the caretReveal step).
    expect(onCommandEvents).toEqual([]);
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

  it("only references command: URIs for commands declared in contributes.commands or a known built-in allowlist", () => {
    const declaredCommandIds = new Set(
      pkg.contributes.commands.map((c: { command: string }) => c.command)
    );
    for (const step of walkthrough.steps) {
      const mediaPath = step.media?.markdown;
      const absolutePath = fileURLToPath(new URL(mediaPath, repoRootUrl));
      const markdown = readFileSync(absolutePath, "utf8");
      for (const commandId of extractCommandUris(markdown)) {
        expect(declaredCommandIds.has(commandId) || builtinCommandAllowlist.has(commandId)).toBe(
          true
        );
      }
    }
  });

  it("encodes the lint-settings.md Settings command URI argument as a JSON array", () => {
    const absolutePath = fileURLToPath(
      new URL("walkthroughs/getting-started/lint-settings.md", repoRootUrl)
    );
    const markdown = readFileSync(absolutePath, "utf8");
    const match = markdown.match(/command:workbench\.action\.openSettings\?([^)]+)/);
    expect(match).not.toBeNull();
    const decoded = decodeURIComponent(match![1]);
    const parsed = JSON.parse(decoded);
    expect(Array.isArray(parsed)).toBe(true);
  });
});
