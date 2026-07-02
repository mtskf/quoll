import { describe, expect, it } from "vitest";
import type { TextDocument, Uri, Webview } from "vscode";

import {
  buildLocalResourceRoots,
  buildResourceBaseUri,
  buildWebviewAssetUris,
} from "../../src/extension/webview-assets.js";

describe("buildWebviewAssetUris", () => {
  // The vscode stub aliased in vitest.config.ts exposes `Uri.joinPath`,
  // returning a `{ path }` plain object. We fake `webview.asWebviewUri` to
  // wrap that into a vscode-resource style string so we can assert the
  // helper's binding of dist/webview/index.{js,css} to the right keys.
  const makeWebview = (): Webview =>
    ({
      asWebviewUri: (u: { path: string }) => ({
        toString: () => `https://csp/${u.path}`,
      }),
    }) as unknown as Webview;

  const extensionUri = { path: "ext" } as unknown as Uri;

  it("returns {scriptUri, stylesUri} bound to dist/webview/index.js and index.css respectively", () => {
    const uris = buildWebviewAssetUris(makeWebview(), extensionUri);
    expect(uris.scriptUri).toBe("https://csp/ext/dist/webview/index.js");
    expect(uris.stylesUri).toBe("https://csp/ext/dist/webview/index.css");
  });

  it("pins the key set so the call site can spread {scriptUri, stylesUri} without confusion", () => {
    // Object.keys assertion prevents a future refactor from collapsing the
    // pair into a positional tuple or renaming a key — the call site relies
    // on spreading into buildWebviewHtml({...assetUris, nonce, cspSource}).
    const uris = buildWebviewAssetUris(makeWebview(), extensionUri);
    expect(Object.keys(uris).sort()).toEqual(["scriptUri", "stylesUri"]);
  });

  it("never collapses js and css under the same URI (swap regression guard)", () => {
    // If a future edit accidentally points both keys at index.js (or both at
    // index.css), the call-site spread would load the CSS as a script or
    // vice-versa. This test would catch that before it shipped.
    const uris = buildWebviewAssetUris(makeWebview(), extensionUri);
    expect(uris.scriptUri).not.toBe(uris.stylesUri);
    expect(uris.scriptUri.endsWith("index.js")).toBe(true);
    expect(uris.stylesUri.endsWith("index.css")).toBe(true);
  });
});

describe("buildResourceBaseUri", () => {
  const makeWebview = (): Webview =>
    ({
      asWebviewUri: (u: { path: string }) => ({ toString: () => `https://csp${u.path}` }),
    }) as unknown as Webview;

  it("returns the webview URI of the document FILE for a file-scheme document", () => {
    const document = { uri: { scheme: "file", path: "/ws/notes/a.md" } } as unknown as TextDocument;
    expect(buildResourceBaseUri(makeWebview(), document)).toBe("https://csp/ws/notes/a.md");
  });

  it("returns empty string for a non-file document (untitled / git / etc.)", () => {
    const document = { uri: { scheme: "untitled", path: "Untitled-1" } } as unknown as TextDocument;
    expect(buildResourceBaseUri(makeWebview(), document)).toBe("");
  });
});

describe("buildLocalResourceRoots", () => {
  const extensionUri = { path: "/ext" } as unknown as Uri;

  it("adds the document's containing folder for a file-scheme document", () => {
    const document = { uri: { scheme: "file", path: "/ws/notes/a.md" } } as unknown as TextDocument;
    const roots = buildLocalResourceRoots(extensionUri, document) as unknown as Array<{
      path: string;
    }>;
    expect(roots).toHaveLength(2);
    expect(roots[0].path).toBe("/ext/dist/webview");
    expect(roots[1].path).toBe("/ws/notes");
  });

  it("restricts to dist/webview only for a non-file document", () => {
    const document = { uri: { scheme: "untitled", path: "Untitled-1" } } as unknown as TextDocument;
    const roots = buildLocalResourceRoots(extensionUri, document) as unknown as Array<{
      path: string;
    }>;
    expect(roots).toHaveLength(1);
    expect(roots[0].path).toBe("/ext/dist/webview");
  });
});
