import { type EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { WebviewToHost } from "../../../shared/protocol.js";
import {
  createImageFileTransport,
  filesFromTransfer,
  imageFileDrop,
} from "../image/image-paste.js";
import { decideTablePaste } from "./html-table-paste.js";
import { decideListPaste } from "./list-reindent.js";
import { createPasteOperationCoordinator, type PasteDecision } from "./paste-operation.js";
import { decideRichPaste } from "./rich-html-paste.js";
import { decideUrlPaste } from "./url-link-paste.js";

// Capture each clipboard flavour and File once, before the DOM event returns.
export function snapshotClipboard(data: DataTransfer | null) {
  const types = Array.from(data?.types ?? []);
  const flavour = (type: string) => ({
    present: types.includes(type),
    value: data?.getData(type) ?? "",
  });
  return {
    plain: flavour("text/plain"),
    html: flavour("text/html"),
    uri: flavour("text/uri-list"),
    files: filesFromTransfer(data),
  };
}

/** First applicable representation owns its complete replacement range. */
export function decideClipboardPaste(
  snapshot: ReturnType<typeof snapshotClipboard>,
  state: EditorState
): PasteDecision | null {
  const table = decideTablePaste(state, snapshot.html.value);
  if (table) {
    return table;
  }
  const url = decideUrlPaste(state, snapshot.plain.value);
  if (url) {
    return url;
  }
  const list = decideListPaste(state, snapshot.plain.value);
  if (list) {
    return list;
  }
  const rich = decideRichPaste(
    state,
    snapshot.html.value,
    snapshot.plain.value || snapshot.uri.value,
    snapshot.files.length > 0
  );
  if (rich?.emittedMarkdownSyntax) {
    return rich;
  }
  if (rich) {
    const text = snapshot.plain.value || snapshot.uri.value;
    return text ? { from: rich.from, to: rich.to, render: () => text } : rich;
  }
  return null;
}

/** Single clipboard owner; File drops share its coordinator and transport. */
export function createClipboardPaste(options: {
  canWrite: () => boolean;
  post: (message: WebviewToHost) => void;
  onFailure: () => void;
  onUnlinkedPath?: (path: string) => void;
}) {
  const reportUnlinked =
    options.onUnlinkedPath ??
    ((relativePath: string) => {
      console.warn("[quoll] pasted image written but not linked", { relativePath });
    });
  const transport = createImageFileTransport({ post: options.post });
  let capturedFiles: readonly File[] = [];
  const coordinator = createPasteOperationCoordinator({
    canWrite: options.canWrite,
    onFailure: options.onFailure,
    onUnlinkedPath: reportUnlinked,
    startResources: (id) =>
      transport.start(capturedFiles, (slot, path) => coordinator.settle(id, slot, path)),
    onReady: (id): void => {
      coordinator.complete(id);
    },
  });
  return {
    extension: [
      coordinator.extension,
      imageFileDrop({
        canWrite: options.canWrite,
        capture(view, files, from) {
          capturedFiles = files;
          coordinator.capture(view, { from, to: from, render: () => "" }, files.length);
          capturedFiles = [];
        },
      }),
      Prec.high(
        EditorView.domEventHandlers({
          paste(event, view) {
            const snapshot = snapshotClipboard(event.clipboardData);
            const text = snapshot.plain.value || snapshot.uri.value;
            const decided = decideClipboardPaste(snapshot, view.state);
            if (!snapshot.files.length && text && !decided) {
              return false;
            }
            event.preventDefault();
            if (!options.canWrite() || view.state.readOnly) {
              return true;
            }
            if (!snapshot.files.length && !text && !decided) {
              options.onFailure();
              return true;
            }
            const { from, to } = view.state.selection.main;
            const decision: PasteDecision = decided ?? { from, to, render: () => text };
            capturedFiles = snapshot.files;
            coordinator.capture(view, decision, snapshot.files.length);
            capturedFiles = [];
            return true;
          },
        })
      ),
    ],
    pastePlain(view: EditorView, text: string) {
      if (!view.hasFocus) {
        return;
      }
      const { from, to } = view.state.selection.main;
      coordinator.capture(view, { from, to, render: () => text }, 0);
    },
    resolve(requestId: string, path: string | null) {
      if (!transport.resolve(requestId, path) && path !== null) {
        reportUnlinked(path);
      }
    },
    dispose: coordinator.dispose,
  };
}
