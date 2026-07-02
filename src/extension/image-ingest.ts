// Pure security gate for the relative-image WRITE path. No `vscode` import.
//
// Trust model: the extension is derived from the SNIFFED magic bytes, never
// from a webview-supplied MIME/extension claim. The filename is a FULL SHA-256
// content hash (hex) + the sniffed extension under a fixed `assets/` literal, so
// there is no user-controlled path component AND no truncation collision can let
// a different image overwrite an existing one (true content addressing → the
// same image dedups to one file; a different image always gets a different name).
//
// SVG is deliberately NOT allowlisted — scriptable XML, and unreliable to sniff.
// The four raster formats are the safe default; sniffing validates a bit beyond
// the bare signature (GIF version, WebP chunk fourCC) so an obviously-malformed
// header is rejected rather than written as garbage.

import { createHash } from "node:crypto";

import { MAX_IMAGE_BYTES } from "../shared/protocol.js";

export type ImageKind = "png" | "jpeg" | "gif" | "webp";

const EXTENSION_BY_KIND: Record<ImageKind, string> = {
  png: "png",
  jpeg: "jpg",
  gif: "gif",
  webp: "webp",
};

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) {
    return false;
  }
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) {
      return false;
    }
  }
  return true;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIG = [0xff, 0xd8, 0xff] as const;
const GIF_SIG = [0x47, 0x49, 0x46, 0x38] as const; // "GIF8"
const GIF_V7 = [0x37, 0x61] as const; // "7a"
const GIF_V9 = [0x39, 0x61] as const; // "9a"
const RIFF_SIG = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_SIG = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP" @ offset 8
// VP8 / VP8L / VP8X chunk fourCC @ offset 12 — the three valid WebP body kinds.
const WEBP_VP8 = [0x56, 0x50, 0x38, 0x20] as const; // "VP8 "
const WEBP_VP8L = [0x56, 0x50, 0x38, 0x4c] as const; // "VP8L"
const WEBP_VP8X = [0x56, 0x50, 0x38, 0x58] as const; // "VP8X"

/** Identify a raster image from its leading magic bytes. Returns null for any
 *  unrecognised / truncated / malformed header. Authoritative — ignores caller
 *  claims. */
export function sniffImageKind(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, PNG_SIG)) {
    return "png";
  }
  if (startsWith(bytes, JPEG_SIG)) {
    return "jpeg";
  }
  if (
    startsWith(bytes, GIF_SIG) &&
    (startsWith(bytes, GIF_V7, 4) || startsWith(bytes, GIF_V9, 4))
  ) {
    return "gif";
  }
  if (
    startsWith(bytes, RIFF_SIG) &&
    startsWith(bytes, WEBP_SIG, 8) &&
    (startsWith(bytes, WEBP_VP8, 12) ||
      startsWith(bytes, WEBP_VP8L, 12) ||
      startsWith(bytes, WEBP_VP8X, 12))
  ) {
    return "webp";
  }
  return null;
}

export type ImageRejectReason = "readonly" | "empty" | "too-large" | "unsupported-type";

export type ImageWriteDecision =
  | { kind: "write"; filename: string; bytes: Uint8Array }
  | { kind: "reject"; reason: ImageRejectReason };

/** Decide whether a decoded pasted/dropped image may be written. Order is
 *  cheapest-and-most-important first: capability, then size, then type. The
 *  filename is `<sha256-hex>.<sniffedExt>` — full-hash content addressing, no
 *  caller-controlled path bytes. */
export function decideImageWrite(canWrite: boolean, bytes: Uint8Array): ImageWriteDecision {
  if (!canWrite) {
    return { kind: "reject", reason: "readonly" };
  }
  if (bytes.length === 0) {
    return { kind: "reject", reason: "empty" };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { kind: "reject", reason: "too-large" };
  }
  const kind = sniffImageKind(bytes);
  if (kind === null) {
    return { kind: "reject", reason: "unsupported-type" };
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { kind: "write", filename: `${hash}.${EXTENSION_BY_KIND[kind]}`, bytes };
}
