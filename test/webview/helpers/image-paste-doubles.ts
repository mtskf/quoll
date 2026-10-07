// Doubles shared by the suites that drive imagePaste through real paste events:
// its own (image/cm-image-paste.test.ts) and the richHtmlPaste + imagePaste pair
// (paste/cm-rich-html-image-paste.test.ts).

import type { ImageWriteMessage, WebviewToHost } from "../../../src/shared/protocol.js";

/** A file that REPORTS `bytes` while its content stays one byte. Both size caps are
 *  decided from `file.size` before the FileReader ever runs, so allocating a real
 *  10–15 MiB buffer per file would only slow the suite down. */
export function sizedImageFile(bytes: number): File {
  const file = new File(["x"], "f", { type: "image/png" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

// No hand-written `m is ImageWriteMessage` on the filter: TypeScript takes a written
// predicate on trust and never checks it against the body, so a wrong one compiles.
// Left off, TS infers the narrowing and the declared return type verifies it.
export function imageWrites(post: {
  mock: { calls: readonly [message: WebviewToHost][] };
}): ImageWriteMessage[] {
  return post.mock.calls.map(([message]) => message).filter((m) => m.type === "image-write");
}
