// Decides whether the custom editor host may apply a `WorkspaceEdit` to a
// document with `scheme`. Kept as a pure function so the panel's write gate
// is unit-testable without the `vscode` runtime, and so the same allowlist
// is enforced from a single place.
//
// Write capability is restricted to on-disk `file:` documents whose
// filesystem is not explicitly read-only. Anything else — untitled, git,
// vscode-vfs, output, https, or an extension-provided custom scheme — is
// rejected. `canEditWith` enforces the same policy for the
// `quoll.editWith` command gate; both call sites share
// `SUPPORTED_FILE_SCHEME` and `IsWritableFileSystem` from
// `../file-system.js`. This closes the gap where a direct `vscode.openWith`
// call or a custom-editor restore could land a non-`file:` document in
// the provider and have its scheme treated as writable just because
// `workspace.fs.isWritableFileSystem` returned `undefined` for it.

import { type IsWritableFileSystem, SUPPORTED_FILE_SCHEME } from "../file-system.js";

export function canHostWrite(scheme: string, isWritableFileSystem: IsWritableFileSystem): boolean {
  if (scheme !== SUPPORTED_FILE_SCHEME) {
    return false;
  }
  // Treat `undefined` ("scheme unknown to VS Code") as writable for the
  // canonical `file:` scheme — VS Code returns `true` in the common case,
  // but `undefined` is the documented fallback. Only an explicit `false`
  // (read-only FS overlay) blocks writes.
  return isWritableFileSystem(scheme) !== false;
}
