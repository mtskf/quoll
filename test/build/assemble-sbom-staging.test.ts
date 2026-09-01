// Non-vacuity pins for scripts/assemble-sbom-staging.sh's fail-closed guards —
// the chain that stands in front of an `rm -rf` on a caller-supplied path.
//
// Both workflows only ever pass the happy-path argument, so CI can never observe
// a guard regression: a "simplification" that drops one of these checks ships
// green. Drive the REAL script end-to-end (a fragment probe is what let the `//`
// bypass sit unnoticed — bash preserves a leading `//` through cd/pwd -P where
// zsh collapses it), rooted in a throwaway fixture so a regression under test
// cannot reach anything that matters.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/assemble-sbom-staging.sh", import.meta.url));

// The script derives REPO_ROOT from `dirname($0)/..`, so a copy under
// <fixture>/scripts/ makes the fixture the "checkout" — the containment guards
// are then exercised against it and never against the real one.
// `exe` defaults to the fixture's own copy; the `//` test below overrides it to
// reach that same copy through a differently-spelled path.
const run = (
  repo: string,
  args: string[],
  exe = join(repo, "scripts", "assemble-sbom-staging.sh")
) => {
  try {
    execFileSync(exe, args, { encoding: "utf8" });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stderr?: string };
    return { code: e.status, stderr: e.stderr ?? "" };
  }
};

let base = "";
let repo = "";
beforeEach(() => {
  // realpath: on macOS the temp dir is reached through a /var -> /private/var
  // symlink, and `pwd -P` resolves it. The `//` case below needs a path with no
  // symlink left to resolve, or the prefix is canonicalised away and the
  // regression it pins becomes unobservable.
  base = realpathSync(mkdtempSync(join(tmpdir(), "sbom-staging-")));
  repo = join(base, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const copy = join(repo, "scripts", "assemble-sbom-staging.sh");
  copyFileSync(SCRIPT, copy);
  chmodSync(copy, 0o755);
  writeFileSync(join(repo, "CANARY"), "do not delete");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("assemble-sbom-staging.sh argument guards", () => {
  it.each([
    ["no argument", (_r: string) => []],
    ["an empty string", (_r: string) => [""]],
    ["a relative path", (_r: string) => ["relative/dir"]],
    ["the filesystem root", (_r: string) => ["/"]],
    ["the double-slash root", (_r: string) => ["//"]],
    ["the triple-slash root", (_r: string) => ["///"]],
    ["a non-existent parent", (_r: string) => ["/no/such/parent/x"]],
    ["a `.` basename", (r: string) => [`${r}/.`]],
    ["a `..` basename", (r: string) => [`${r}/..`]],
    ["the checkout itself", (r: string) => [r]],
    ["the checkout's parent", (r: string) => [dirname(r)]],
    ["the checkout via an interior `..`", (r: string) => [`${r}/scripts/../../${basename(r)}`]],
  ])("exits 2 on %s, leaving the tree untouched", (_label, mk) => {
    expect(run(repo, mk(repo)).code).toBe(2);
    expect(existsSync(join(repo, "CANARY"))).toBe(true);
  });

  // The `.`/`..` cases above are repo-relative, so the CONTAINMENT arms reject
  // them and the basename guard could be deleted with every one of them still
  // green. Pin it with an input only it rejects: a `..` basename resolving
  // OUTSIDE the checkout. Without the guard, STAGING is rebuilt as
  // "<base>/outside/.." — textually unrelated to REPO_ROOT, so both containment
  // arms pass and `rm -rf` resolves through the `..` onto <base>, taking the
  // checkout with it. Assert the message, not just the code: exiting 2 from a
  // different guard would not pin this one.
  it("exits 2 on a `..` basename that resolves outside the checkout", () => {
    mkdirSync(join(base, "outside"));
    // Concatenate, don't `join()` — path.join normalises the `..` away, which
    // would silently turn this into a plain "checkout's parent" case that a
    // different guard rejects.
    const res = run(repo, [`${join(base, "outside")}/..`]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("must name a directory");
    expect(existsSync(join(repo, "CANARY"))).toBe(true);
  });

  // Regression: a `//`-prefixed spelling of the checkout resolved to the same
  // directory but shared no textual prefix with REPO_ROOT, so every containment
  // check missed it and `rm -rf` ran on the checkout. Assert the message too —
  // exiting 2 for some other reason would not pin the collapse.
  it("exits 2 on a `//`-prefixed spelling of the checkout", () => {
    const res = run(repo, [`/${repo}`]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("it is the repo root or contains it");
    expect(existsSync(join(repo, "CANARY"))).toBe(true);
  });

  // The `//` hazard is two-sided: both containment arms compare TEXT, so it is
  // not enough to normalise the argument. Invoked through a `//`-prefixed path,
  // REPO_ROOT inherits the prefix from `$0` (bash's cd/pwd -P keep it) and both
  // arms go blind — here the inside-the-checkout argument, which is rejected
  // normally, would reach `rm -rf`.
  it("exits 2 when invoked through a `//`-prefixed script path", () => {
    const res = run(
      repo,
      [join(repo, "sbom-src")],
      `/${join(repo, "scripts", "assemble-sbom-staging.sh")}`
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("must live outside the repo checkout");
    expect(existsSync(join(repo, "CANARY"))).toBe(true);
  });

  // The containment guard is symmetric: a path INSIDE the checkout would delete
  // checkout content AND leave the staging tree where publish.yml's
  // package/audit/attest steps pick it up.
  it("exits 2 on a path inside the checkout", () => {
    const res = run(repo, [join(repo, "sbom-src")]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("must live outside the repo checkout");
    expect(existsSync(join(repo, "CANARY"))).toBe(true);
  });

  // `cd` fails on more than a missing parent (a regular file, an unsearchable
  // dir); the diagnostic must not assert one specific cause.
  it("exits 2 when the parent is a regular file, without claiming it is missing", () => {
    writeFileSync(join(base, "afile"), "");
    const res = run(repo, [join(base, "afile", "child")]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("is not an accessible directory");
  });
});
