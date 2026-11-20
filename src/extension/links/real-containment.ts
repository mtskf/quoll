import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/** True when `realTarget` is `realRoot` itself or a descendant of it.
 *  Both paths have already been resolved by the caller. */
export function isRealPathWithinRoot(realTarget: string, realRoot: string): boolean {
  const rel = relative(realRoot, realTarget);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export type RealContainment = "inside" | "outside" | "missing";

/** Check containment using absolute native paths. */
export async function resolveRealContainment(targetPath: string, rootPath: string): Promise<RealContainment> {
  try {
    const realRoot = await realpath(rootPath);
    try {
      await lstat(targetPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return "missing";
      }
      throw err;
    }

    try {
      const realTarget = await realpath(targetPath);
      return isRealPathWithinRoot(realTarget, realRoot) ? "inside" : "outside";
    } catch (err) {
      // An existing leaf with no resolvable referent may be a dangling symlink.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "outside";
      }
      throw err;
    }
  } catch (err) {
    console.warn("[quoll] realpath containment check failed", { targetPath, rootPath, err });
    return "outside";
  }
}
