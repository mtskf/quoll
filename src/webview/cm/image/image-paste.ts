// Callback-based File transport and drop adapter. Neither inserts document content.

import { EditorView } from "@codemirror/view";

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DATA_LENGTH,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../../../shared/protocol.js";
import { safePostMessage } from "../../safe-post-message.js";

const MAX_IMAGES_PER_EVENT = 16;
// Aggregate byte ceiling per paste/drop so a multi-file drop cannot queue an
// unbounded amount of base64 transient (16 × the transfer ceiling would
// otherwise be ~224 MiB). Once exceeded, remaining files in the event are
// dropped (console.warn).
const MAX_TOTAL_IMAGE_BYTES_PER_EVENT = 4 * MAX_IMAGE_BYTES; // 40 MiB

/** Estimated base64 length of `size` bytes — gross-oversized files are dropped
 *  before the (expensive) FileReader encode. */
function estimatedBase64Length(size: number): number {
  return Math.ceil(size / 3) * 4;
}

/** Shared transport bounds preserve enumeration order and stop at the aggregate ceiling. */
function visitTransferFiles(
  files: readonly File[],
  accept: (file: File, slot: number) => void,
  refuse: (slot: number) => void
) {
  if (files.length > MAX_IMAGES_PER_EVENT) {
    console.warn(
      `[quoll] dropped ${files.length - MAX_IMAGES_PER_EVENT} image(s) (per-event count cap of ${MAX_IMAGES_PER_EVENT} reached)`
    );
  }
  let totalBytes = 0;
  let aggregateExceeded = false;
  files.forEach((file, slot) => {
    if (slot >= MAX_IMAGES_PER_EVENT || aggregateExceeded) {
      refuse(slot);
    } else if (estimatedBase64Length(file.size) > MAX_IMAGE_DATA_LENGTH) {
      console.warn("[quoll] dropped oversized image (exceeds transfer ceiling)");
      refuse(slot);
    } else if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES_PER_EVENT) {
      console.warn("[quoll] dropped image (per-event aggregate byte cap reached)");
      aggregateExceeded = true;
      refuse(slot);
    } else {
      totalBytes += file.size;
      accept(file, slot);
    }
  });
}

/** File transport settles callbacks only; it never retains or edits an EditorView. */
export function createImageFileTransport(opts: { post: (message: WebviewToHost) => void }) {
  let seq = 0;
  // Late replies from an earlier webview session must not resolve a fresh request.
  const sessionNonce = crypto.randomUUID();
  const pending = new Map<string, (path: string | null) => void>();
  function resolve(requestId: string, path: string | null): boolean {
    const callback = pending.get(requestId);
    if (!callback) {
      return false;
    }
    pending.delete(requestId);
    callback(path);
    return true;
  }
  function submit(file: File, onResult: (path: string | null) => void): () => void {
    const requestId = `${sessionNonce}-${++seq}`;
    pending.set(requestId, onResult);
    const failed = () => {
      if (pending.delete(requestId)) {
        onResult(null);
      }
    };
    const reader = new FileReader();
    reader.onload = () => {
      if (!pending.has(requestId)) {
        return;
      }
      const result = reader.result;
      if (typeof result !== "string") {
        // Defensive browser-contract failure; log metadata without clipboard bytes.
        console.warn("[quoll] dropped pasted image (FileReader returned a non-string result)", {
          requestId,
        });
        failed();
        return;
      }
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : "";
      if (base64 === "" && (file.size !== 0 || comma < 0)) {
        // Empty Files are forwarded, but malformed or unexpectedly empty reads fail locally.
        console.warn("[quoll] dropped pasted image (data URL carried no base64 payload)", {
          requestId,
        });
        failed();
        return;
      }
      const ok = safePostMessage(
        { postMessage: opts.post },
        { protocol: PROTOCOL_VERSION, type: "image-write", requestId, data: base64 },
        "image-write"
      );
      if (!ok) {
        failed();
      }
    };
    reader.onerror = () => {
      // The browser error distinguishes read failures without exposing file contents.
      console.error("[quoll] failed to read pasted image", { err: reader.error, requestId });
      failed();
    };
    reader.onabort = failed;
    try {
      reader.readAsDataURL(file);
    } catch (err) {
      console.error("[quoll] failed to start reading pasted image", { err, requestId });
      failed();
    }
    return () => {
      pending.delete(requestId);
      reader.onload = reader.onerror = reader.onabort = null;
      reader.abort?.();
    };
  }
  function start(files: readonly File[], onResult: (slot: number, path: string | null) => void) {
    const cancel: (() => void)[] = [];
    visitTransferFiles(
      files,
      (file, slot) => cancel.push(submit(file, (path) => onResult(slot, path))),
      (slot) => onResult(slot, null)
    );
    return () =>
      cancel.forEach((release) => {
        release();
      });
  }
  return { start, resolve };
}

/** Acquire each obtainable File once; the host decides acceptance from its bytes. */
export function filesFromTransfer(data: DataTransfer | null): File[] {
  const files: File[] = [];
  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

/** File drops submit a collapsed target to the same coordinator as clipboard paste. */
export function imageFileDrop(options: {
  canWrite: () => boolean;
  capture: (view: EditorView, files: readonly File[], from: number) => void;
}) {
  return EditorView.domEventHandlers({
    dragover(event) {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
        event.preventDefault();
      }
      return false;
    },
    drop(event, view) {
      const files = filesFromTransfer(event.dataTransfer);
      if (!files.length) {
        return false;
      }
      event.preventDefault();
      if (!options.canWrite() || view.state.readOnly) {
        return true;
      }
      const from =
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      options.capture(view, files, from);
      return true;
    },
  });
}
