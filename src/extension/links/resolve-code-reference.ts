// Pure host gate for a webview code reference. Re-validates the UNTRUSTED path
// and resolves it to contained candidate Uris under the workspace-folder roots
// (doc-dir fallback when standalone or when the doc is outside every workspace
// folder). Existence is checked separately (async).
// Intended for reuse by PR2's host-side existence/resolve handler so security
// logic lives in one place (the webview decoration uses a separate
// parseInlineCodeReference gate, not this module).

import type { Uri } from "vscode";
import { isAllowedUrl } from "../../markdown/url-allowlist.js";
import { isWithinDir } from "./within-dir.js";

export type ResolveCodeReferenceDeps = {
  documentUri: Uri;
  workspaceFolderUris: readonly Uri[];
  joinPath: (base: Uri, ...segments: string[]) => Uri;
};

/** A lexically-contained candidate + the base root it was resolved under (the
 *  async existence check canonicalises the target within this root). */
export type ResolvedCodeReferenceCandidate = { target: Uri; root: Uri };

export function resolveCodeReferenceCandidates(
  path: string,
  deps: ResolveCodeReferenceDeps
): ResolvedCodeReferenceCandidate[] {
  if (path === "" || !isAllowedUrl(path)) {
    return [];
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || path.includes("\\")) {
    return [];
  }
  if (/\.md$/i.test(path)) {
    return []; // .md is open-link's domain (opens in Quoll), never a text editor.
  }
  // In a multi-root workspace, try the folder that CONTAINS the document first
  // so a same-named file in the doc's own folder wins over a sibling folder's.
  // Containing folders first, MOST-SPECIFIC (longest path) first — so a document
  // under a nested workspace root (`/repo/packages/a`) resolves against that
  // nested root before its parent (`/repo`), honouring the own-folder precedence
  // even when both roots contain the document.
  const containing = deps.workspaceFolderUris
    .filter((f) => isWithinDir(deps.documentUri, f))
    .sort((a, b) => b.path.length - a.path.length);
  // With no workspace open, or when the document lives OUTSIDE every workspace
  // folder, resolve against the doc's own directory first — a doc-adjacent file
  // must win over an unrelated workspace root instead of silently falling back
  // to one. (Host-side open still re-validates workspace containment.)
  const bases =
    containing.length > 0
      ? [
          ...containing,
          ...deps.workspaceFolderUris.filter((f) => !isWithinDir(deps.documentUri, f)),
        ]
      : [
          deps.joinPath(deps.documentUri, ".."),
          ...deps.workspaceFolderUris.filter((f) => !isWithinDir(deps.documentUri, f)),
        ];
  const out: ResolvedCodeReferenceCandidate[] = [];
  for (const base of bases) {
    const target = deps.joinPath(base, path);
    if (isWithinDir(target, base)) {
      out.push({ target, root: base });
    }
  }
  return out;
}
