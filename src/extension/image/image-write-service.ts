// Thin host-side adapter for the image WRITE path. Keeps QuollEditorPanel a pure
// router: it injects `vscode` capabilities (FS write, write-capability, toast,
// result post) as `deps`, so this service unit-tests without the runtime AND a
// future VS Code FS API change is swapped here, not in the Panel.

import { MAX_IMAGE_DATA_LENGTH } from "../../shared/protocol.js";
import { decideImageWrite, type ImageRejectReason } from "./image-ingest.js";
import type { SessionVolumeBudget } from "./image-write-budget.js";

export function imageRejectToast(reason: ImageRejectReason): string {
  switch (reason) {
    case "readonly":
      return "Quoll: cannot insert an image into a read-only document.";
    case "empty":
      return "Quoll: the pasted image was empty.";
    case "too-large":
      return "Quoll: image exceeds the 10 MB limit and was not inserted.";
    case "unsupported-type":
      return "Quoll: unsupported image type — only PNG, JPEG, GIF, and WebP can be pasted.";
  }
}

export type ImageWriteDeps = {
  /** Live write capability (host canWriteNow()). */
  canWrite: () => boolean;
  /** Create assets/ + write the validated bytes; resolves the document-relative
   *  markdown path. Rejects on FS failure. Injected by the Panel. */
  writeImage: (filename: string, bytes: Uint8Array) => Thenable<string>;
  /** Surface a user-facing toast (host showError). */
  showError: (message: string) => void;
  /** Post the image-write-result; `null` path ⇒ ok:false. */
  postResult: (requestId: string, relativePath: string | null) => void;
  /** Session cumulative-volume budget (the DoS cap this service enforces).
   *  REQUIRED, not optional: a security-load-bearing dep must never default to
   *  "unbounded" — callers that genuinely want no cap pass an all-permitting
   *  budget explicitly, so "unbounded" is a visible decision, not a silent one.
   *  reserve() is charged AFTER validation (only bytes past every per-message
   *  gate) and BEFORE the write; the charge is never refunded, so total disk
   *  growth stays bounded by the budget even when a write fails and leaves a
   *  partial file (see SessionVolumeBudget.reserve). The budget owns its own
   *  one-time warning, so a budget rejection posts ok:false WITHOUT a showError. */
  budget: SessionVolumeBudget;
};

/** Validate + write a base64 image and post the result. Never throws — every
 *  failure path posts a result so the webview's pending entry is cleared. */
export async function handleImageWrite(
  deps: ImageWriteDeps,
  requestId: string,
  data: string
): Promise<void> {
  // Read-only guard FIRST — cheapest and most important, and it avoids decoding a
  // (potentially ~14 MiB) Buffer for a write the host will reject anyway. Without
  // this ordering, a flood of `image-write` messages aimed at a read-only document
  // forces one large base64 decode + heap allocation per message before rejection
  // (resource-exhaustion path). `decideImageWrite` re-checks canWrite so it stays
  // self-contained for its own unit tests.
  if (!deps.canWrite()) {
    deps.showError(imageRejectToast("readonly"));
    deps.postResult(requestId, null);
    return;
  }
  // Self-contained bound: in production the protocol validator already capped
  // data.length, but the service must not ASSUME its caller did — reject without
  // allocating a huge Buffer from an over-cap string.
  if (data.length > MAX_IMAGE_DATA_LENGTH) {
    deps.showError(imageRejectToast("too-large"));
    deps.postResult(requestId, null);
    return;
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  const decision = decideImageWrite(deps.canWrite(), bytes);
  if (decision.kind === "reject") {
    deps.showError(imageRejectToast(decision.reason));
    deps.postResult(requestId, null);
    return;
  }
  // Session cumulative-volume gate: reserve the validated byte count (only bytes
  // past every per-message gate above) BEFORE the async write so concurrent
  // fire-and-forget writes can't each overshoot the cap. The charge is not
  // refunded on failure (see SessionVolumeBudget.reserve — a failed write can
  // still leave a partial file, so counting the attempt keeps disk bounded). The
  // budget surfaces its own one-time warning, so this rejection just clears the
  // webview's pending entry.
  if (!deps.budget.reserve(decision.bytes.length)) {
    deps.postResult(requestId, null);
    return;
  }
  // Scope the try to the write ALONE: a throw here means the write failed. The
  // success-path post is deliberately OUTSIDE it so a postResult that throws is
  // not misread as a write failure (wrong toast + double post).
  let relativePath: string;
  try {
    relativePath = await deps.writeImage(decision.filename, decision.bytes);
  } catch (err) {
    console.error("[quoll] image write failed", err);
    deps.showError(
      "Quoll: failed to write the image file. See the extension host log for details."
    );
    deps.postResult(requestId, null);
    return;
  }
  deps.postResult(requestId, relativePath);
}
