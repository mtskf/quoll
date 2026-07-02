// Single construction point for the webview's asset URIs.
//
// Why extracted: returning a typed { scriptUri, stylesUri } object means
// the panel call site spreads the result into buildWebviewHtml; the
// scriptUri and stylesUri are bound by key, so a copy-paste swap that
// would have loaded the CSS as a script becomes structurally impossible.

import { type TextDocument, Uri, type Webview } from "vscode";

export type WebviewAssetUris = {
  scriptUri: string;
  stylesUri: string;
};

export function buildWebviewAssetUris(webview: Webview, extensionUri: Uri): WebviewAssetUris {
  return {
    scriptUri: webview
      .asWebviewUri(Uri.joinPath(extensionUri, "dist", "webview", "index.js"))
      .toString(),
    stylesUri: webview
      .asWebviewUri(Uri.joinPath(extensionUri, "dist", "webview", "index.css"))
      .toString(),
  };
}

/**
 * Webview-resource base URI for resolving a document's relative image paths.
 * Returns the webview URI of the document FILE itself (not its folder) so the
 * webview can resolve `new URL("./img.png", base)` to a sibling without a
 * trailing-slash dance — the file's last path segment is treated as the
 * "document location" exactly as a browser would. Empty string for non-file
 * documents (untitled / git / output), which have no on-disk folder to resolve
 * against; the webview then leaves relative images unresolved (inert).
 */
export function buildResourceBaseUri(webview: Webview, document: TextDocument): string {
  if (document.uri.scheme !== "file") {
    return "";
  }
  return webview.asWebviewUri(document.uri).toString();
}

/**
 * localResourceRoots for the editor webview. Always includes dist/webview/
 * (the bundle root). For file-scheme documents it ALSO includes the document's
 * containing folder so relative images resolve; VS Code blocks any resource
 * outside all roots, so path traversal above the folder is contained. Non-file
 * documents get the bundle root only (minimal surface, no folder to grant).
 */
export function buildLocalResourceRoots(extensionUri: Uri, document: TextDocument): Uri[] {
  const distWebviewRoot = Uri.joinPath(extensionUri, "dist", "webview");
  if (document.uri.scheme !== "file") {
    return [distWebviewRoot];
  }
  return [distWebviewRoot, Uri.joinPath(document.uri, "..")];
}
