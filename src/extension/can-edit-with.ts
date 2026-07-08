// Decides whether `quoll.editWith` may open `document`. Kept as a pure
// function with a structural document shape so it is unit-testable without
// importing the `vscode` runtime — the command handler in `extension.ts`
// adapts the live `TextDocument` and `workspace.fs.isWritableFileSystem`
// reference to this contract at the call site.
//
// `workspace.fs.isWritableFileSystem` returns `true` for writable schemes,
// `false` for known read-only ones, and `undefined` if the scheme is unknown.
// We treat unknown the same way `canHostWrite` (the editor-provider write
// gate) does: once the `file:` scheme guard has passed, `undefined` from
// `isWritableFileSystem` is treated as writable. Both utilities share
// `SUPPORTED_FILE_SCHEME` and `IsWritableFileSystem` from `./fileSystem`
// so the command gate and the write gate stay in sync.

import { type IsWritableFileSystem, SUPPORTED_FILE_SCHEME } from "./file-system.js";

export interface EditWithCandidate {
  readonly uri: { readonly scheme: string; readonly path: string };
  readonly languageId: string;
}

export type EditWithDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function canEditWith(
  document: EditWithCandidate,
  isWritableFileSystem: IsWritableFileSystem
): EditWithDecision {
  const { uri, languageId } = document;
  if (uri.scheme !== SUPPORTED_FILE_SCHEME) {
    return {
      ok: false,
      reason: `Quoll can only open files on disk (scheme "${uri.scheme}" is not supported).`,
    };
  }
  const lowerPath = uri.path.toLowerCase();
  // The custom editor selector in package.json is `*.md`, so .mdx is
  // intentionally excluded — short-circuit before the markdown OR below to
  // also catch the edge case of an .mdx file whose languageId is "markdown".
  if (lowerPath.endsWith(".mdx")) {
    return { ok: false, reason: "Quoll does not support MDX (.mdx) files." };
  }
  const isMarkdown = languageId === "markdown" || lowerPath.endsWith(".md");
  if (!isMarkdown) {
    return {
      ok: false,
      reason: "Quoll only opens Markdown files (.md / markdown language).",
    };
  }
  if (isWritableFileSystem(uri.scheme) === false) {
    return { ok: false, reason: "Quoll cannot open a read-only document." };
  }
  return { ok: true };
}
