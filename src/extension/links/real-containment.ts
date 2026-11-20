import { isAbsolute, relative } from "node:path";

/** True when `realTarget` is `realRoot` itself or a descendant of it.
 *  Both paths have already been resolved by the caller. */
export function isRealPathWithinRoot(realTarget: string, realRoot: string): boolean {
  const rel = relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
