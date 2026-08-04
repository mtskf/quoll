// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
import {
  addPendingAnchor,
  createImagePasteDrop,
  isIngestibleImageItem,
  pendingImageAnchors,
} from "../../../src/webview/cm/image/image-paste.js";
import { firePasteAt, IMAGE_FILE, makeClipboardData } from "../helpers/clipboard-double.js";

function mount(doc: string, canWrite = true) {
  const post = vi.fn();
  const paste = createImagePasteDrop({ canWrite: () => canWrite, post });
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [paste.extension] }),
  });
  return { view, paste, post };
}

describe("pendingImageAnchors", () => {
  it("maps an anchor through an intervening insertion", () => {
    const { view } = mount("hello");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 5 }) });
    view.dispatch({ changes: { from: 0, insert: "XX" } });
    expect(view.state.field(pendingImageAnchors).find((p) => p.requestId === "1")?.anchor).toBe(7);
  });

  it("keeps anchors on a same-content reseed but clears them on a wholesale reseed", () => {
    const { view } = mount("hello");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 3 }) });
    view.dispatch({ annotations: hostDocumentReseed.of(true) }); // no changes → keep
    expect(view.state.field(pendingImageAnchors).length).toBe(1);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "world" },
      annotations: hostDocumentReseed.of(true),
    });
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
  });
});

describe("resolve", () => {
  it("inserts a standalone image link at the mapped anchor and clears the entry", () => {
    const { view, paste } = mount("ab");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 1 }) });
    paste.resolve(view, "1", "./assets/x.png");
    expect(view.state.doc.toString()).toBe("a\n![](./assets/x.png)\nb");
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
  });

  it("does NOT insert on a read-only doc at resolve time (clears pending)", () => {
    const { view, paste } = mount("ab", false);
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 1 }) });
    paste.resolve(view, "1", "./assets/x.png");
    expect(view.state.doc.toString()).toBe("ab");
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
  });

  it("does NOT insert when the host rejected (relativePath null)", () => {
    const { view, paste } = mount("ab");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 1 }) });
    paste.resolve(view, "1", null);
    expect(view.state.doc.toString()).toBe("ab");
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
  });

  it("ignores an unknown requestId", () => {
    const { view, paste } = mount("ab");
    paste.resolve(view, "nope", "./assets/x.png");
    expect(view.state.doc.toString()).toBe("ab");
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
  });
});

describe("isIngestibleImageItem", () => {
  // This predicate is the whole of the coupling between two handlers: richHtmlPaste
  // runs FIRST and defers to imagePaste on exactly the set this returns true for.
  // A `true` imagePaste will not honour means richHtmlPaste defers, imagePaste
  // declines, and CM core's doPaste("") replaces the user's selection with nothing.
  // Both directions are pinned because both are load-bearing: over-match deletes
  // text, under-match swallows a legitimate image paste.
  const itemsOf = (data: Parameters<typeof makeClipboardData>[0]): DataTransferItem[] =>
    makeClipboardData(data).items;

  it("accepts a file item carrying a real image File", () => {
    const items = itemsOf({ files: IMAGE_FILE });
    expect(items.filter(isIngestibleImageItem).length).toBe(1);
  });

  it.each([
    ["a non-image file (a copied PDF)", [{ type: "application/pdf" }]],
    ["an image item whose getAsFile() is null", [{ type: "image/png", file: null }]],
    ["an image item whose getAsFile() is undefined", [{ type: "image/png", file: undefined }]],
  ])("rejects %s", (_label, files) => {
    expect(itemsOf({ files }).some(isIngestibleImageItem)).toBe(false);
  });

  it("rejects the kind:'string' text flavours a real clipboard always carries", () => {
    // Not a hypothetical: every clipboard with a text/html or text/plain flavour
    // lists these, so a scan over `items` meets them before any file entry.
    expect(itemsOf({ html: "<p>x</p>", text: "x" }).some(isIngestibleImageItem)).toBe(false);
  });

  it("finds the image among the text flavours of a mixed clipboard", () => {
    // The shape that actually reaches richHtmlPaste's defer decision: rich HTML,
    // plain text AND a bitmap, all on one clipboard.
    const items = itemsOf({ html: "<p>x</p>", text: "x", files: IMAGE_FILE });
    expect(items.length).toBe(3);
    expect(items.filter(isIngestibleImageItem).length).toBe(1);
  });
});

describe("imagePaste — clipboard ingestion", () => {
  // The predicate above decides membership; these pin that imagePaste ACTS on
  // exactly that set — the half that makes richHtmlPaste's defer safe. Without
  // them the shared predicate could be correct while imageFilesFrom stopped using
  // it, and richHtmlPaste would be deferring into a handler that no longer accepts
  // what it was promised.
  //
  // Observed on pendingImageAnchors, not on defaultPrevented: CM's own builtin
  // paste handler runs after this one on a decline and preventDefaults for its own
  // plain-text insert, so defaultPrevented cannot tell "imagePaste took it" from
  // "imagePaste passed and CM handled it" (repo convention — see
  // cm-list-reindent-paste.test.ts). An anchor is queued SYNCHRONOUSLY when a file
  // is submitted; the image-write post itself rides an async FileReader.
  it("ingests a paste carrying an image file, even beside text flavours", () => {
    const { view } = mount("ab");
    firePasteAt(view.contentDOM, { files: IMAGE_FILE, html: "<p>x</p>", text: "x" });
    expect(view.state.field(pendingImageAnchors).length).toBe(1);
    view.destroy();
  });

  it.each([
    ["a non-image file", [{ type: "application/pdf" }]],
    ["an image item that yields no File", [{ type: "image/png", file: null }]],
    ["an image item that yields undefined", [{ type: "image/png", file: undefined }]],
    ["no file at all", []],
  ])("declines a paste carrying only %s", (_label, files) => {
    // Declining is what makes richHtmlPaste's `hasImageFileItem` a data-loss test
    // rather than a preference: on these clipboards nothing downstream performs the
    // paste, so richHtmlPaste must NOT defer into them.
    const { view } = mount("ab");
    firePasteAt(view.contentDOM, { files, text: "x" });
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    view.destroy();
  });

  it("declines a text-only paste (its kind:'string' items are not files)", () => {
    const { view } = mount("ab");
    firePasteAt(view.contentDOM, { html: "<p>x</p>", text: "x" });
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    view.destroy();
  });

  it("swallows an image paste on a read-only doc without queueing an anchor", () => {
    const { view } = mount("ab", false);
    const event = firePasteAt(view.contentDOM, { files: IMAGE_FILE });
    // Here defaultPrevented IS meaningful: with no text/plain there is nothing for
    // CM core to insert, so the only handler that could have prevented is this one.
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    view.destroy();
  });
});
