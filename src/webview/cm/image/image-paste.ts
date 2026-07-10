// Capture pasted/dropped image files and round-trip them through the host write
// path. Capture-only re: the host: this module posts `image-write` and, on the
// host's reply, inserts `![](relativePath)` at a position-mapped anchor. The
// insert rides the normal CM updateListener → edit-sync → host write pipeline.

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DATA_LENGTH,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../../../shared/protocol.js";
import { safePostMessage } from "../../safe-post-message.js";
import { hostDocumentReseed } from "../host-reseed.js";

const MAX_IMAGES_PER_EVENT = 16;
// Aggregate byte ceiling per paste/drop so a multi-file drop cannot queue an
// unbounded amount of base64 transient (16 × the transfer ceiling would
// otherwise be ~224 MiB). Once exceeded, remaining files in the event are
// dropped (console.warn).
const MAX_TOTAL_IMAGE_BYTES_PER_EVENT = 4 * MAX_IMAGE_BYTES; // 40 MiB

type PendingAnchor = { requestId: string; anchor: number };

// Exported for unit tests (test/webview/cm-image-paste.test.ts) to seed/inspect
// pending anchors without driving real DOM paste/drop events.
export const addPendingAnchor = StateEffect.define<PendingAnchor>();
export const removePendingAnchor = StateEffect.define<string>(); // requestId

/** Tracks in-flight image-write anchors and maps each through doc changes so the
 *  link lands at the right place after the async host round-trip. Exported for
 *  unit tests. */
export const pendingImageAnchors = StateField.define<readonly PendingAnchor[]>({
  create: () => [],
  update(value, tr) {
    // A host reseed that ACTUALLY replaces the doc (wholesale 0..len) collapses
    // mapped anchors to the replace boundary (≈EOF). Drop all pending anchors —
    // the file is still written but the link is not inserted (orphan, idempotent
    // on re-paste), which is correct vs. inserting at a wrong spot. BUT a
    // same-content reseed (applyDocument with needsReseed=false: a version/
    // canWrite-only ack) carries the annotation WITHOUT a doc change — positions
    // are unchanged, so anchors must be KEPT (else a paste + keep-typing whose
    // edit acks mid-round-trip would silently lose its image link). Gate the
    // clear on tr.docChanged.
    // Note: a reseed transaction never also carries addPendingAnchor — paste and
    // reseed always dispatch separately — so early-returning here (skipping the
    // effects loop below) cannot drop a freshly-added anchor.
    if (tr.annotation(hostDocumentReseed)) {
      if (tr.docChanged) {
        return value.length === 0 ? value : [];
      }
      return value; // no-op reseed: positions intact, keep pending anchors
    }
    let next = value;
    if (tr.docChanged) {
      next = next.map((p) => ({ ...p, anchor: tr.changes.mapPos(p.anchor, 1) }));
    }
    for (const effect of tr.effects) {
      if (effect.is(addPendingAnchor)) {
        next = [...next, effect.value];
      } else if (effect.is(removePendingAnchor)) {
        next = next.filter((p) => p.requestId !== effect.value);
      }
    }
    return next;
  },
});

function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }
  return files;
}

/** Estimated base64 length of `size` bytes — gross-oversized files are dropped
 *  before the (expensive) FileReader encode. */
function estimatedBase64Length(size: number): number {
  return Math.ceil(size / 3) * 4;
}

export function createImagePasteDrop(opts: {
  canWrite: () => boolean;
  post: (message: WebviewToHost) => void;
}): {
  extension: Extension;
  resolve: (view: EditorView, requestId: string, relativePath: string | null) => void;
} {
  let seq = 0;
  // Per-session nonce so requestIds never collide across a webview reload. A bare
  // counter resets to 1 on reload; a late image-write-result from the previous
  // session (same "1") would otherwise resolve a fresh pending anchor and insert
  // the wrong image path. With the nonce, a stale reply falls into resolve()'s
  // unknown-requestId no-op.
  const sessionNonce = crypto.randomUUID();

  // Dispatch guarded against a view torn down mid-round-trip (tab closed between
  // FileReader start and callback) — CM throws on dispatch to a destroyed view.
  // The catch is intentionally scoped to THIS hazard: `pendingImageAnchors`'
  // update() only filters/maps and cannot throw, so nothing else legitimately
  // surfaces here.
  const clearPending = (view: EditorView, requestId: string): void => {
    try {
      view.dispatch({ effects: removePendingAnchor.of(requestId) });
    } catch {
      // view destroyed mid-round-trip — pending state dies with it.
    }
  };

  const submit = (view: EditorView, file: File, anchor: number): void => {
    const requestId = `${sessionNonce}-${++seq}`;
    // Register the anchor BEFORE the async read so it maps from capture time.
    // Synchronous, inside the live event handler → no destroyed-view risk here.
    view.dispatch({ effects: addPendingAnchor.of({ requestId, anchor }) });
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        clearPending(view, requestId);
        return;
      }
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : "";
      if (base64 === "") {
        clearPending(view, requestId);
        return;
      }
      const ok = safePostMessage(
        { postMessage: opts.post },
        { protocol: PROTOCOL_VERSION, type: "image-write", requestId, data: base64 },
        "image-write"
      );
      if (!ok) {
        clearPending(view, requestId);
      }
    };
    reader.onerror = () => {
      // No webview toast channel; rare browser-internal failure. Log + clear the
      // pending anchor so nothing leaks. (Documented in the security-audit note.)
      console.error("[quoll] failed to read pasted image");
      clearPending(view, requestId);
    };
    reader.readAsDataURL(file);
  };

  // Caller contract: invoked only with files.length > 0 AND canWrite() === true,
  // after the caller has already preventDefault'd the event. Submits each
  // in-cap image; returns true so the event stays handled even when every file
  // is gross-oversized (stops the browser navigating to a dropped file).
  const handle = (view: EditorView, files: File[], anchor: number): boolean => {
    let totalBytes = 0;
    for (const file of files.slice(0, MAX_IMAGES_PER_EVENT)) {
      if (file.size === 0) {
        continue;
      }
      if (estimatedBase64Length(file.size) > MAX_IMAGE_DATA_LENGTH) {
        console.warn("[quoll] dropped oversized image (exceeds transfer ceiling)");
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES_PER_EVENT) {
        console.warn("[quoll] dropped image (per-event aggregate byte cap reached)");
        break;
      }
      totalBytes += file.size;
      submit(view, file, anchor);
    }
    return true;
  };

  const extension: Extension = [
    pendingImageAnchors,
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const files = imageFilesFrom(event.clipboardData);
        if (files.length === 0) {
          return false; // no image — let CM handle normal text paste
        }
        event.preventDefault(); // image files present — we own this event
        if (!opts.canWrite()) {
          return true; // read-only: swallow without writing
        }
        return handle(view, files, view.state.selection.main.head);
      },
      dragover: (event) => {
        if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault(); // allow the drop event to fire for file drags
        }
        return false;
      },
      drop: (event, view) => {
        const files = imageFilesFrom(event.dataTransfer);
        if (files.length === 0) {
          return false;
        }
        event.preventDefault(); // image file drop — never let the browser open it
        if (!opts.canWrite()) {
          return true; // read-only: swallow without writing
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        return handle(view, files, pos ?? view.state.selection.main.head);
      },
    }),
  ];

  const resolve = (view: EditorView, requestId: string, relativePath: string | null): void => {
    const pending = view.state.field(pendingImageAnchors).find((p) => p.requestId === requestId);
    if (!pending) {
      return; // unknown / duplicate / already-resolved / cleared by a reseed
    }
    if (relativePath === null || !opts.canWrite()) {
      // Host rejected (toast already shown) OR doc went read-only mid-round-trip:
      // clear the anchor without inserting (avoid a link edit-sync would drop).
      clearPending(view, requestId);
      return;
    }
    const anchor = pending.anchor;
    const line = view.state.doc.lineAt(anchor);
    // Standalone block: break onto its own line when mid-line; always close with
    // a newline so the read-path renders it as a block image. Multiple images
    // from one event insert in completion order (see Design notes).
    const prefix = anchor === line.from ? "" : "\n";
    const insert = `${prefix}![](${relativePath})\n`;
    // resolve runs synchronously from the shell's `editor?.` null-guarded handler
    // (view alive), but guard the dispatch for symmetry with the async paths.
    try {
      view.dispatch({
        changes: { from: anchor, insert },
        selection: { anchor: anchor + insert.length },
        effects: removePendingAnchor.of(requestId),
        scrollIntoView: true,
      });
    } catch {
      // view torn down between the shell null-check and here — no-op.
    }
  };

  return { extension, resolve };
}
