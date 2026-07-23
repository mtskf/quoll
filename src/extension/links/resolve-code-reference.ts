// Pure host gate for a webview code reference. Re-validates the UNTRUSTED path
// and resolves it to contained candidate Uris under the workspace-folder roots
// (doc-dir fallback when standalone). Existence is checked separately (async).
// Shared with PR2's decoration resolver so security logic lives in one place.

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
  const bases =
    deps.workspaceFolderUris.length > 0
      ? deps.workspaceFolderUris
      : [deps.joinPath(deps.documentUri, "..")];
  const out: ResolvedCodeReferenceCandidate[] = [];
  for (const base of bases) {
    const target = deps.joinPath(base, path);
    if (isWithinDir(target, base)) {
      out.push({ target, root: base });
    }
  }
  return out;
}
