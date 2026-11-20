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

import { lstat } from "node:fs/promises";
import { Uri, workspace } from "vscode";

import type { HostToWebview } from "../../shared/protocol.js";
import type { RealContainment } from "../links/real-containment.js";
import { buildImageWriteResultMessage } from "../session/document-message.js";
import {
  createSessionVolumeBudget,
  SESSION_IMAGE_WRITE_BUDGET_BYTES,
  SESSION_IMAGE_WRITE_BUDGET_TOAST,
} from "./image-write-budget.js";
import { handleImageWrite } from "./image-write-service.js";

export interface ImageWriteWiringDeps {
  /** The document whose parent folder hosts ./assets/ and against which the
   *  document-relative markdown path is derived. */
  readonly documentUri: Uri;
  /** Live host write capability (canWriteNow). Lazy — a runtime read-only flip
   *  must be reflected per request. */
  readonly canWrite: () => boolean;
  /** Production: resolveRealContainment. Checks the target against the
   *  document folder's real path before anything is created or written. */
  readonly realContainment: (targetPath: string, rootPath: string) => Promise<RealContainment>;
  /** Surface a user-facing toast (host showError). */
  readonly showError: (message: string) => void;
  /** Post a host→webview message (the effect executor's post). */
  readonly post: (message: HostToWebview) => void;
  /** Getter for the test override of the raw file write
   *  (harness.writeImageFileOverride) — read PER WRITE (it can be set after
   *  resolve). null routes to workspace.fs.writeFile. */
  readonly writeFileOverride: () => ((uri: Uri, content: Uint8Array) => Thenable<void>) | null;
  /** Session cumulative-volume ceiling in bytes. Defaults to
   *  SESSION_IMAGE_WRITE_BUDGET_BYTES; overridable only so tests can trip the cap
   *  without allocating half a gigabyte. */
  readonly budgetBytes?: number;
}

export interface ImageWriteWiring {
  /** Validate + write a base64 image and post the result. Fire-and-forget: the
   *  service never throws — every failure path posts a result. */
  handle(requestId: string, data: string): void;
}

export function createImageWriteWiring(deps: ImageWriteWiringDeps): ImageWriteWiring {
  // One budget per wiring instance = one per panel = one per editor session. It
  // owns its own one-time warning (a per-write toast would be a flood vector).
  const budget = createSessionVolumeBudget(
    deps.budgetBytes ?? SESSION_IMAGE_WRITE_BUDGET_BYTES,
    () => deps.showError(SESSION_IMAGE_WRITE_BUDGET_TOAST)
  );
  return {
    handle(requestId: string, data: string): void {
      void handleImageWrite(
        {
          canWrite: deps.canWrite,
          showError: deps.showError,
          budget,
          postResult: (id, relativePath) =>
            deps.post(buildImageWriteResultMessage(id, relativePath)),
          // writeImage checks containment, creates <docFolder>/assets/, then
          // writes — the explicit createDirectory removes any dependency on
          // writeFile's (undocumented) parent-dir behaviour and is idempotent.
          writeImage: async (filename, bytes) => {
            const docDir = Uri.joinPath(deps.documentUri, "..");
            const assetsDir = Uri.joinPath(docDir, "assets");
            const target = Uri.joinPath(assetsDir, filename);
            // Before any side effect. A write must not follow a link even when
            // its referent is inside: a symlinked or hardlinked <sha>.png could
            // point at the document itself. An existing leaf is accepted only
            // as a single-link regular file (a same-bytes rewrite).
            const verdict = await deps.realContainment(target.fsPath, docDir.fsPath);
            if (
              verdict === "outside" ||
              (verdict === "inside" && !(await isPlainFile(target.fsPath)))
            ) {
              console.warn(
                "[quoll] image-write rejected: path escapes the document folder or is a symlink",
                { target: target.fsPath, docDir: docDir.fsPath }
              );
              throw new Error("image-write target refused");
            }
            await workspace.fs.createDirectory(assetsDir);
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

async function isPlainFile(fsPath: string): Promise<boolean> {
  const stat = await lstat(fsPath);
  return stat.isFile() && stat.nlink === 1;
}
