// Host-side image-WRITE wiring for QuollEditorPanel. The pure validate + write
// service lives in image-write-service.ts (handleImageWrite) and the byte-sniff
// / content-address decision in image-ingest.ts (decideImageWrite); this module
// owns the VS Code wiring AROUND that service — the <docFolder>/assets/ dir
// create, the writeFile override resolution, and the image-write-result post.
// It imports vscode (mirroring disk-conflict-wiring.ts) because that wiring IS
// this slice's substance; keeping it vscode-free would only push the same
// wiring back into the panel.
//
// ORTHOGONAL to the document-text write lock: it writes a SEPARATE binary file,
// not the TextDocument, so it never enters the host-session core and holds no
// shared mutable state. canWrite() is the read-only guard (defense in depth: the
// webview also drops paste on !canWrite). The vscode-free logic stays pinned by
// the image-write-service + image-ingest unit suites + the image-write-readonly
// e2e, which this only re-wires.

import { Uri, workspace } from "vscode";

import type { HostToWebview } from "../shared/protocol.js";
import { buildImageWriteResultMessage } from "./document-message.js";
import { handleImageWrite } from "./image-write-service.js";

export interface ImageWriteWiringDeps {
  /** The document whose parent folder hosts ./assets/ and against which the
   *  document-relative markdown path is derived. */
  readonly documentUri: Uri;
  /** Live host write capability (canWriteNow). Lazy — a runtime read-only flip
   *  must be reflected per request. */
  readonly canWrite: () => boolean;
  /** Surface a user-facing toast (host showError). */
  readonly showError: (message: string) => void;
  /** Post a host→webview message (the effect executor's post). */
  readonly post: (message: HostToWebview) => void;
  /** Getter for the test override of the raw file write
   *  (harness.writeImageFileOverride) — read PER WRITE (it can be set after
   *  resolve). null routes to workspace.fs.writeFile. */
  readonly writeFileOverride: () => ((uri: Uri, content: Uint8Array) => Thenable<void>) | null;
}

export interface ImageWriteWiring {
  /** Validate + write a base64 image and post the result. Fire-and-forget: the
   *  service never throws — every failure path posts a result. */
  handle(requestId: string, data: string): void;
}

export function createImageWriteWiring(deps: ImageWriteWiringDeps): ImageWriteWiring {
  return {
    handle(requestId: string, data: string): void {
      void handleImageWrite(
        {
          canWrite: deps.canWrite,
          showError: deps.showError,
          postResult: (id, relativePath) =>
            deps.post(buildImageWriteResultMessage(id, relativePath)),
          // writeImage creates <docFolder>/assets/ then writes — the explicit
          // createDirectory removes any dependency on writeFile's (undocumented)
          // parent-dir behaviour and is idempotent.
          writeImage: async (filename, bytes) => {
            const assetsDir = Uri.joinPath(deps.documentUri, "..", "assets");
            await workspace.fs.createDirectory(assetsDir);
            const target = Uri.joinPath(assetsDir, filename);
            const write: (uri: Uri, content: Uint8Array) => Thenable<void> =
              deps.writeFileOverride() ?? ((uri, content) => workspace.fs.writeFile(uri, content));
            await write(target, bytes);
            return `./assets/${filename}`;
          },
        },
        requestId,
        data
      );
    },
  };
}
