import type { Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect } from "vitest";

import {
  type DocumentEol,
  type DocumentMessage,
  type EditMessage,
  type HostToWebview,
  type ImageWriteMessage,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../../../src/shared/protocol.js";

/** Real production entry in its own realm; only the VS Code host is simulated. */
export async function productionPasteFixture(content = "", eol: DocumentEol = "\n") {
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:800px;height:360px;border:0";
  frame.srcdoc = `<!doctype html><html><head>
    <link rel="stylesheet" href="/__quoll-production/index.css">
    <style>body { --vscode-font-family: sans-serif; --vscode-font-size: 14px; }</style>
    </head><body><div id="root"></div></body></html>`;
  const loaded = new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });
  document.body.append(frame);
  await loaded;
  const win = frame.contentWindow as Window & typeof globalThis;
  const doc = win.document;
  const messages: WebviewToHost[] = [];
  const warnings: unknown[][] = [];
  const warn = win.console.warn.bind(win.console);
  win.console.warn = (...args: unknown[]) => {
    warnings.push(args);
    warn(...args);
  };
  let snapshot: DocumentMessage = {
    protocol: PROTOCOL_VERSION,
    type: "document",
    content,
    docVersion: 1,
    themeKind: "light",
    canWrite: true,
    eol,
    externalEpoch: 0,
    epochGeneration: 1,
    settledEditId: 0,
  };
  const send = (message: HostToWebview) => win.postMessage(message, "*");
  Object.defineProperty(win, "acquireVsCodeApi", {
    value: () => ({
      getState: () => undefined,
      setState: () => {},
      postMessage(message: WebviewToHost) {
        messages.push(message);
        if (message.type === "ready") {
          send(snapshot);
        }
        if (message.type === "edit") {
          snapshot = {
            ...snapshot,
            content: message.content,
            docVersion: snapshot.docVersion + 1,
            settledEditId: message.editId,
          };
          send(snapshot);
        }
      },
    }),
  });
  const script = doc.createElement("script");
  script.type = "module";
  script.src = "/__quoll-production/index.js";
  doc.body.append(script);
  try {
    await expect.poll(() => messages.some((message) => message.type === "ready")).toBe(true);
    await expect.poll(() => doc.querySelector(".cm-content")).not.toBeNull();
    const editor = doc.querySelector<HTMLElement>(".cm-content");
    if (!editor) {
      throw new Error("Production editor did not mount");
    }
    const view = EditorView.findFromDOM(editor);
    if (!view) {
      throw new Error("Production EditorView not found");
    }
    await expect.poll(() => view.state.doc.toString()).toBe(content.replace(/\r\n?/g, "\n"));

    // Observe dispatch without injecting foreign facets, effects or extensions.
    let documentChanges = 0;
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (...args: (Transaction | readonly Transaction[] | TransactionSpec)[]) => {
      const before = view.state.doc;
      Reflect.apply(dispatch, view, args);
      if (!before.eq(view.state.doc)) {
        documentChanges++;
      }
    };
    const edits = () =>
      messages.filter((message): message is EditMessage => message.type === "edit");
    const requests = () =>
      messages.filter((message): message is ImageWriteMessage => message.type === "image-write");
    return {
      frame,
      win,
      view,
      messages,
      warnings,
      edits,
      requests,
      changes: () => documentChanges,
      async select(anchor: number, head = anchor) {
        editor.focus();
        const a = view.domAtPos(anchor);
        const b = view.domAtPos(head);
        win.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
        doc.dispatchEvent(new win.Event("selectionchange"));
        await expect
          .poll(() => [view.state.selection.main.anchor, view.state.selection.main.head])
          .toEqual([anchor, head]);
      },
      paste(flavours: Record<string, string>, files: readonly string[] = []) {
        const transfer = new win.DataTransfer();
        for (const [type, value] of Object.entries(flavours)) {
          transfer.setData(type, value);
        }
        for (const name of files) {
          transfer.items.add(new win.File([name], name, { type: "image/png" }));
        }
        editor.dispatchEvent(
          new win.ClipboardEvent("paste", {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          })
        );
      },
      reply(request: ImageWriteMessage, path: string | null) {
        send(
          path === null
            ? {
                protocol: PROTOCOL_VERSION,
                type: "image-write-result",
                requestId: request.requestId,
                ok: false,
              }
            : {
                protocol: PROTOCOL_VERSION,
                type: "image-write-result",
                requestId: request.requestId,
                ok: true,
                relativePath: path,
              }
        );
      },
      async type(text: string) {
        const before = view.state.doc.length;
        editor.focus();
        if (!doc.execCommand("insertText", false, text)) {
          throw new Error("Browser text input failed");
        }
        await expect.poll(() => view.state.doc.length).toBe(before + text.length);
      },
      history(redo = false) {
        editor.focus();
        const mac = /Mac/.test(win.navigator.platform);
        editor.dispatchEvent(
          new win.KeyboardEvent("keydown", {
            key: "z",
            code: "KeyZ",
            metaKey: mac,
            ctrlKey: !mac,
            shiftKey: redo,
            bubbles: true,
            cancelable: true,
          })
        );
      },
      async readOnly() {
        snapshot = { ...snapshot, canWrite: false, docVersion: snapshot.docVersion + 1 };
        send(snapshot);
        await expect.poll(() => view.state.readOnly).toBe(true);
      },
      async posted(expected: string, count = 1) {
        await expect.poll(() => edits().length).toBe(count);
        expect(edits().at(-1)?.content).toBe(expected);
        await expect.poll(() => snapshot.settledEditId).toBe(edits().at(-1)?.editId);
        // Allow duplicate or delayed edits to surface past the production debounce.
        await new Promise((resolve) => setTimeout(resolve, 450));
        expect(edits()).toHaveLength(count);
      },
      dispose: () => frame.remove(),
    };
  } catch (error) {
    frame.remove();
    throw error;
  }
}
