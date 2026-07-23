// Production wrappers for the open-code-reference host handler. Kept separate
// from the pure handler so the gate unit-tests without a live VS Code host.
// Named to avoid colliding with reopen-text-editor.ts's openInTextEditor.

import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { FileType, Position, Selection, type Uri, window, workspace } from "vscode";

/** Pure containment predicate: true when `realTarget` is `realRoot` itself or a
 *  descendant of it. node:path only (no I/O) so it unit-tests without a live
 *  host — the realpath resolution happens in the async wrapper below. */
export function isRealPathWithinRoot(realTarget: string, realRoot: string): boolean {
  const rel = relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True only when `target` exists, is a regular file, AND its REAL (symlink-
 *  canonicalised) path stays within `root`'s real path. realpath'ing BOTH sides
 *  closes ancestor-directory-symlink containment escapes (and handles a
 *  workspace that is itself under a symlink) — the authoritative check behind
 *  the resolver's lexical pre-filter. Residual TOCTOU (realpath → open) is
 *  accepted: the open is read-only text display, never execution. */
export async function codeReferenceFileExistsWithinRoot(target: Uri, root: Uri): Promise<boolean> {
  try {
    const stat = await workspace.fs.stat(target);
    if ((stat.type & FileType.File) === 0) {
      return false;
    }
    const realTarget = await realpath(target.fsPath);
    const realRoot = await realpath(root.fsPath);
    if (!isRealPathWithinRoot(realTarget, realRoot)) {
      // A real file resolving OUTSIDE the workspace root is a containment
      // escape (e.g. via a symlink) — security-relevant, log it. Fail closed.
      console.warn("[quoll] code-reference rejected: real path escapes workspace root", {
        target: target.fsPath,
        root: root.fsPath,
      });
      return false;
    }
    return true;
  } catch (err) {
    // A missing file is the normal/benign case — stay quiet. Anything else is
    // unexpected (permissions, I/O) and worth surfacing. Still fail closed.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[quoll] code-reference existence check failed", err);
    }
    return false;
  }
}

/** Open `uri` in a plain text editor with the caret at the (1-based) line/col,
 *  clamped via validatePosition. Missing line → top; missing col → column 1. */
export async function revealCodeReference(uri: Uri, line?: number, col?: number): Promise<void> {
  const doc = await workspace.openTextDocument(uri);
  const raw = new Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (col ?? 1) - 1));
  const pos = doc.validatePosition(raw);
  await window.showTextDocument(doc, { selection: new Selection(pos, pos), preview: true });
}
