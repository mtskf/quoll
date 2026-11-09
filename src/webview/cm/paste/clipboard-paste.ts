import { type EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { WebviewToHost } from "../../../shared/protocol.js";
import { createImageFileTransport } from "../image/image-paste.js";
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
  return {
    plain: flavour("text/plain"),
    html: flavour("text/html"),
    uri: flavour("text/uri-list"),
    files,
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

/** Independent clipboard entry; production remains on the temporary legacy adapter. */
export function createClipboardPaste(options: {
  canWrite: () => boolean;
  post: (message: WebviewToHost) => void;
  onFailure: () => void;
  onUnlinkedPath?: (path: string) => void;
}) {
  const transport = createImageFileTransport({ post: options.post });
  let capturedFiles: readonly File[] = [];
  const coordinator = createPasteOperationCoordinator({
    onFailure: options.onFailure,
    onUnlinkedPath: options.onUnlinkedPath,
    startResources: (id) =>
      transport.start(capturedFiles, (slot, path) => coordinator.settle(id, slot, path)),
    onReady: (id): void => {
      coordinator.complete(id);
    },
  });
  return {
    extension: [
      coordinator.extension,
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
            if (!options.canWrite()) {
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
    resolve: transport.resolve,
    dispose: coordinator.dispose,
  };
}
