import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";

/** True when `realTarget` is `realRoot` itself or a descendant of it.
 *  Both paths have already been resolved by the caller. */
export function isRealPathWithinRoot(realTarget: string, realRoot: string): boolean {
  const rel = relative(realRoot, realTarget);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export type RealContainment = "inside" | "outside" | "missing";

/** Check containment using absolute native paths. */
export async function resolveRealContainment(
  targetPath: string,
  rootPath: string
): Promise<RealContainment> {
  try {
    const realRoot = await realpath(rootPath);
    const existingPath = await findExistingEntry(targetPath);
    if (existingPath === undefined) {
      console.warn("[quoll] realpath containment walk reached the filesystem root", {
        targetPath,
        rootPath,
      });
      return "outside";
    }

    const realTarget = await realpathIfPresent(existingPath);
    if (realTarget === undefined || !isRealPathWithinRoot(realTarget, realRoot)) {
      return "outside";
    }
    return existingPath === targetPath ? "inside" : "missing";
  } catch (err) {
    console.warn("[quoll] realpath containment check failed", { targetPath, rootPath, err });
    return "outside";
  }
}

async function entryExists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw err;
  }
}

async function findExistingEntry(targetPath: string): Promise<string | undefined> {
  let entry = targetPath;
  // lstat stops the search at dangling symlinks too.
  while (!(await entryExists(entry))) {
    const parent = dirname(entry);
    if (parent === entry) {
      return undefined;
    }
    entry = parent;
  }
  return entry;
}

async function realpathIfPresent(entryPath: string): Promise<string | undefined> {
  try {
    return await realpath(entryPath);
  } catch (err) {
    // An existing entry with no resolvable referent may be a dangling symlink.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}
