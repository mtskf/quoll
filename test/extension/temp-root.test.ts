import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunTempRoot,
  makeTempDir,
  makeTempDirSync,
  RUN_TEMP_ROOT_ENV,
  type RunTempRoot,
  resolveRunTempWorkDir,
} from "./temp-root";

const created: RunTempRoot[] = [];

const newRoot = (): RunTempRoot => {
  const run = createRunTempRoot();
  created.push(run);
  return run;
};

afterEach(() => {
  for (const run of created.splice(0)) {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
  delete process.env[RUN_TEMP_ROOT_ENV];
});

describe("createRunTempRoot", () => {
  it("gives each run a unique root holding the user-data and work dirs", () => {
    const a = newRoot();
    const b = newRoot();
    expect(a.root).not.toBe(b.root);
    // os.tmpdir() unresolved — the module must NOT realpath it. On macOS the
    // resolved form (`/private/var/…`) reaches VS Code as a document URI and
    // breaks the disk-conflict watcher's exact-string event filter.
    expect(path.dirname(a.root)).toBe(os.tmpdir());
    expect(path.basename(a.root).startsWith("quoll-e2e-")).toBe(true);
    expect(path.dirname(a.userDataDir)).toBe(a.root);
    expect(path.dirname(a.workDir)).toBe(a.root);
    expect(fs.existsSync(a.userDataDir)).toBe(true);
    expect(fs.existsSync(a.workDir)).toBe(true);
  });

  it("keeps the code's own contribution inside the macOS socket budget", () => {
    // VS Code opens its IPC socket under --user-data-dir and macOS caps
    // those paths at 103 chars; an overlong path fails the launch, not a
    // test. Measure only the part this module controls — asserting the
    // absolute length would pass on CI (where $TMPDIR is `/tmp`, 56 chars
    // of slack) and so would never catch a rename of the segments.
    const run = newRoot();
    const owned = run.userDataDir.slice(os.tmpdir().length);
    expect(owned).toBe(`${path.sep}${path.basename(run.root)}${path.sep}ud`);
    expect(owned.length).toBeLessThanOrEqual(24);
  });

  it.skipIf(process.getuid?.() === 0)(
    "throws when the filesystem refuses, rather than leaking silently",
    () => {
      // The other half of the dispose contract. `not.toThrow()` on an
      // already-removed root is satisfied by `force: true` alone, so a
      // dispose() that swallowed everything would pass it — this case is what
      // distinguishes "loud on unreclaimable" from "silently gives up".
      const run = newRoot();
      const locked = path.join(run.workDir, "locked");
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, "f.md"), "x");
      fs.chmodSync(locked, 0o500);
      try {
        expect(() => run.dispose()).toThrow();
      } finally {
        fs.chmodSync(locked, 0o700); // afterEach must still be able to reclaim
      }
    },
    15000 // dispose retries with linear backoff before giving up
  );

  it("reclaims a non-empty root", () => {
    const run = newRoot();
    fs.writeFileSync(path.join(run.workDir, "leftover.md"), "# x\n");
    run.dispose();
    expect(fs.existsSync(run.root)).toBe(false);
  });

  it("dispose is idempotent on an already-removed root", () => {
    const run = newRoot();
    run.dispose();
    expect(() => run.dispose()).not.toThrow();
  });
});

describe("resolveRunTempWorkDir", () => {
  it("returns the work dir under the exported root", () => {
    const run = newRoot();
    expect(resolveRunTempWorkDir({ [RUN_TEMP_ROOT_ENV]: run.root })).toBe(run.workDir);
  });

  it("throws a diagnosable error when the runner did not export the root", () => {
    expect(() => resolveRunTempWorkDir({})).toThrow(RUN_TEMP_ROOT_ENV);
    expect(() => resolveRunTempWorkDir({})).toThrow(/launch\.ts/);
  });
});

describe("makeTempDir", () => {
  it("allocates unique slug-named dirs under the run's work dir", async () => {
    const run = newRoot();
    process.env[RUN_TEMP_ROOT_ENV] = run.root;

    const first = await makeTempDir("crlf");
    const second = await makeTempDir("crlf");
    const sync = makeTempDirSync("swap");

    expect(first).not.toBe(second);
    for (const dir of [first, second, sync]) {
      expect(path.dirname(dir)).toBe(run.workDir);
      expect(fs.existsSync(dir)).toBe(true);
    }
    expect(path.basename(first).startsWith("crlf-")).toBe(true);
    expect(path.basename(sync).startsWith("swap-")).toBe(true);

    // The whole footprint goes with the ONE root removal — this is why no
    // suite needs per-dir teardown of its own.
    run.dispose();
    expect(fs.existsSync(first)).toBe(false);
  });

  it("refuses a slug that would escape the run's work dir", async () => {
    // `path.join` normalises `../`, so a separator in a slug lands the dir
    // outside the root — where nothing disposes it. The choke-point test
    // governs who allocates; this governs where the result lands.
    const run = newRoot();
    process.env[RUN_TEMP_ROOT_ENV] = run.root;
    await expect(makeTempDir("../escape")).rejects.toThrow(/bare name/);
    expect(() => makeTempDirSync("a/b")).toThrow(/bare name/);
  });
});
