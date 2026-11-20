// Pins that no locked glob is paired with a minimatch it cannot drive.
//
// The unscoped `minimatch` override in pnpm-workspace.yaml (Dependabot #108)
// forces minimatch 11 onto every consumer. minimatch 11 emits `Matcher`
// objects in `Minimatch.set`, which glob <= 12 cannot process: it reads the
// sibling minimatch, so any wildcard pattern silently matches nothing. For
// mocha that surfaces as ERR_MOCHA_NO_FILES_MATCH_PATTERN (mocha@11 pins
// glob ^10). glob 13 ships a self-contained bundle with its own minimatch,
// so the override never reaches it; glob 14 handles `Matcher` natively.
// Hence the scoped `mocha>glob` override.
//
// Reads the lockfile on disk rather than node_modules so a lockfile revert
// goes red without a reinstall.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const lock = readFileSync(fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url)), "utf8");

// First glob major that works alongside minimatch 11 (see header).
const FIRST_SAFE_GLOB_MAJOR = 13;

const major = (version: string): number => Number.parseInt(version, 10);

/** `snapshots:` entries, keyed by `name@version`, with their resolved deps. */
function snapshots(text: string): Map<string, Map<string, string>> {
  // An autocrlf checkout turns the lockfile into CRLF; the parse is LF-based.
  const lf = text.replace(/\r\n/g, "\n");
  const section = lf.slice(lf.indexOf("\nsnapshots:\n"));
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
  const all = snapshots(lock);
  const globs = [...all].filter(([key]) => key.startsWith("glob@"));

  it("parses the glob snapshots it guards", () => {
    // Non-vacuity: a parser regression must not empty the set below.
    expect(globs.length).toBeGreaterThan(0);
    for (const [, deps] of globs) {
      expect(deps.get("minimatch")).toBeDefined();
    }
  });

  it("parses a CRLF lockfile the same as an LF one", () => {
    expect(snapshots(lock.replace(/\n/g, "\r\n"))).toEqual(all);
  });

  it("pairs minimatch 11+ only with a glob that can drive it", () => {
    const broken = globs
      .filter(([, deps]) => major(deps.get("minimatch") ?? "0") >= 11)
      .map(([key]) => key)
      .filter((key) => major(key.slice("glob@".length)) < FIRST_SAFE_GLOB_MAJOR);
    expect(broken).toEqual([]);
  });
});
