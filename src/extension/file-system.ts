// Shared primitives for the host-side write gate. `canHostWrite` (the
// custom-editor provider's runtime gate) and `canEditWith` (the
// `quoll.editWith` command gate) both encode the same allowlist —
// keep the type and scheme constant in one place so a future scheme
// addition or a `workspace.fs.isWritableFileSystem` signature change
// touches a single file.

export type IsWritableFileSystem = (scheme: string) => boolean | undefined;

export const SUPPORTED_FILE_SCHEME = "file";
