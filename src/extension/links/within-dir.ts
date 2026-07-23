// Lexical containment predicate shared by the open-link and open-code-reference
// gates. True when `target` is `dir` or a descendant (same scheme + authority +
// path-prefix). `dir.path` normalised to exactly one trailing slash so `/ws`
// does not match `/ws-evil/x`. Case-sensitive by design (a case-insensitive FS
// can only over-block, never bypass). NOTE: lexical only — does not resolve
// symlinks (see the open-code-reference plan's Known limitations).

import type { Uri } from "vscode";

export function isWithinDir(target: Uri, dir: Uri): boolean {
  if (target.scheme !== dir.scheme || target.authority !== dir.authority) {
    return false;
  }
  const dirPath = dir.path.replace(/\/?$/, "/");
  return target.path === dir.path || target.path.startsWith(dirPath);
}
