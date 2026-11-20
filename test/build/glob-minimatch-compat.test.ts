// Pins that no locked glob is paired with a minimatch it cannot drive.
//
// The unscoped `minimatch` override in pnpm-workspace.yaml (Dependabot #108)
// forces minimatch 11 onto every consumer. minimatch 11 emits `Matcher`
// objects in `Minimatch.set`, but glob <= 12's processor only understands
// string / GLOBSTAR / RegExp segments, so any wildcard pattern silently
// matches nothing. For mocha that surfaces as ERR_MOCHA_NO_FILES_MATCH_PATTERN
// on any glob spec (mocha@11 pins glob ^10). glob 13+ handles `Matcher`
// (measured against mocha's lib/cli/lookup-files.js), hence the scoped
// `mocha>glob` override.
//
// Reads the lockfile on disk rather than node_modules so a lockfile revert
// goes red without a reinstall.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const lock = readFileSync(fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url)), "utf8");

// First glob major whose processor understands minimatch 11's Matcher.
const FIRST_MATCHER_AWARE_GLOB = 13;

const major = (version: string): number => Number.parseInt(version, 10);

/** `snapshots:` entries, keyed by `name@version`, with their resolved deps. */
function snapshots(): Map<string, Map<string, string>> {
  const section = lock.slice(lock.indexOf("\nsnapshots:\n"));
  const result = new Map<string, Map<string, string>>();
  let deps: Map<string, string> | undefined;
  for (const line of section.split("\n")) {
    const entry = /^ {2}'?([^\s']+?)'?:$/.exec(line);
    if (entry?.[1] !== undefined) {
      deps = new Map();
      result.set(entry[1], deps);
      continue;
    }
    const dep = /^ {6}'?([^\s':]+)'?: '?([^\s']+)'?$/.exec(line);
    if (deps !== undefined && dep?.[1] !== undefined && dep[2] !== undefined) {
      deps.set(dep[1], dep[2]);
    }
  }
  return result;
}

describe("glob / minimatch lockfile compatibility", () => {
  const all = snapshots();
  const globs = [...all].filter(([key]) => key.startsWith("glob@"));

  it("parses the glob snapshots it guards", () => {
    // Non-vacuity: a parser regression must not empty the set below.
    expect(globs.length).toBeGreaterThan(0);
    for (const [, deps] of globs) {
      expect(deps.get("minimatch")).toBeDefined();
    }
  });

  it("pairs minimatch 11+ only with a Matcher-aware glob", () => {
    const broken = globs
      .filter(([, deps]) => major(deps.get("minimatch") ?? "0") >= 11)
      .map(([key]) => key)
      .filter((key) => major(key.slice("glob@".length)) < FIRST_MATCHER_AWARE_GLOB);
    expect(broken).toEqual([]);
  });
});
