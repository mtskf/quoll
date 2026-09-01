// One temp root per E2E run. The process that CREATES the disposable state
// owns removing it: launch.ts mkdtemps this root, hands the path to the
// Electron host through extensionTestsEnv, and removes exactly this path in
// a finally. Nothing here ever globs `quoll-e2e-*` — a parallel run (a CI
// shard, a second agent's worktree) owns its own root and must survive ours.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Env var carrying the run root into the Electron host. */
export const RUN_TEMP_ROOT_ENV = "QUOLL_E2E_TEMP_ROOT";

// Deliberately two-letter: VS Code opens a unix-domain IPC socket under
// --user-data-dir and macOS caps those paths at 103 chars, of which $TMPDIR
// alone is 48. Nobody reads these paths, so a longer name buys no
// readability — only a launch-blocking risk.
const USER_DATA_SEGMENT = "ud";
const WORK_SEGMENT = "w";

export interface RunTempRoot {
  /** The only directory under os.tmpdir() this run may write to. */
  readonly root: string;
  /** VS Code --user-data-dir. */
  readonly userDataDir: string;
  /** Parent of every per-test workspace dir the suites allocate. */
  readonly workDir: string;
  /** Remove the whole root. Safe to call twice; THROWS if the filesystem
   *  refuses (EBUSY / EACCES) — a leak we cannot reclaim must be loud. */
  dispose(): void;
}

export function createRunTempRoot(): RunTempRoot {
  // os.tmpdir() as-is, NOT realpath'd. On macOS it returns the `/var/folders/…`
  // symlink whose target is `/private/var/folders/…`, and the paths built here
  // become document URIs inside VS Code. The disk-conflict watcher filters
  // events by exact URI string, so handing it the resolved form makes those
  // comparisons miss and the dirty-doc-disk-conflict suite time out.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quoll-e2e-"));
  const userDataDir = path.join(root, USER_DATA_SEGMENT);
  const workDir = path.join(root, WORK_SEGMENT);
  try {
    fs.mkdirSync(userDataDir);
    fs.mkdirSync(workDir);
  } catch (err) {
    // Partial init still owns the root: reclaim it before the caller ever
    // holds a handle, otherwise the throw leaks the dir we just created.
    // The rollback must never become the reported failure — whatever broke
    // mkdir is the diagnosable cause (a read-only or full $TMPDIR breaks
    // both), so log a failed rollback and rethrow the original.
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(`[e2e] failed to reclaim partially-created temp root ${root}:`, cleanupErr);
    }
    throw err;
  }
  return {
    root,
    userDataDir,
    workDir,
    dispose(): void {
      // ~3s of retries (linear backoff: 200, 400, … 1000). dispose() fires the
      // instant the Electron main process closes, while VS Code's helpers may
      // still be writing under user-data-dir. An ENOTEMPTY there is a race,
      // not a leak, and must not flip a green run red; a throw past this
      // budget means genuinely unreclaimable, which is worth failing for.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/** The work dir of the run this process belongs to. Throws (rather than
 *  silently falling back to os.tmpdir()) because a fallback would restore
 *  the very leak this module exists to close. */
export function resolveRunTempWorkDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env[RUN_TEMP_ROOT_ENV];
  if (!root) {
    throw new Error(
      `${RUN_TEMP_ROOT_ENV} is unset — the E2E suite must be launched through test/extension/launch.ts`
    );
  }
  return path.join(root, WORK_SEGMENT);
}

/** Reject anything that could climb out of the work dir. `path.join`
 *  normalises `../`, so a slug carrying a separator would land a dir OUTSIDE
 *  the run root — where nothing disposes it. The choke-point test governs who
 *  allocates; this governs where the result lands. */
function assertSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    throw new Error(`temp-dir slug must be a bare name, got ${JSON.stringify(slug)}`);
  }
  return slug;
}

/** Allocate a per-test workspace dir under the run root. This is the ONLY
 *  sanctioned temp-dir allocation in the E2E tree — enforced by
 *  test/extension/temp-dir-choke-point.test.ts.
 *  `async` is load-bearing: `resolveRunTempWorkDir` / `assertSlug` throw
 *  synchronously, and a declared `Promise` must deliver that as a rejection. */
export async function makeTempDir(slug: string): Promise<string> {
  return fsp.mkdtemp(path.join(resolveRunTempWorkDir(), `${assertSlug(slug)}-`));
}

export function makeTempDirSync(slug: string): string {
  return fs.mkdtempSync(path.join(resolveRunTempWorkDir(), `${assertSlug(slug)}-`));
}
