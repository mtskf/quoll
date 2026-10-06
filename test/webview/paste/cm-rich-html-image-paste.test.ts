// @vitest-environment happy-dom
// richHtmlPaste and imagePaste as the REAL pair, in editor.ts's order (richHtmlPaste
// first; it is Prec.high regardless). cm-rich-html-paste.test.ts pins the hand-off
// against a sentinel; this file pins what the two handlers produce together when
// one clipboard carries a convertible `text/html` flavour AND an image file item.
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_BYTES, type WebviewToHost } from "../../../src/shared/protocol.js";
import {
  createImagePasteDrop,
  pendingImageAnchors,
} from "../../../src/webview/cm/image/image-paste.js";
import { richHtmlPaste } from "../../../src/webview/cm/paste/rich-html-paste.js";
import { firePasteAt, IMAGE_FILE } from "../helpers/clipboard-double.js";
import { imageWrites, sizedImageFile } from "../helpers/image-paste-doubles.js";

const CAPTION_HTML = "<div>caption</div>";

function mount(doc: string, canWrite = true) {
  const post = vi.fn<(message: WebviewToHost) => void>();
  const paste = createImagePasteDrop({ canWrite: () => canWrite, post });
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        history(),
        EditorState.readOnly.of(!canWrite),
        richHtmlPaste({ canWrite: () => canWrite }),
        paste.extension,
      ],
    }),
  });
  return { view, paste, post };
}

const anchors = (view: EditorView) => view.state.field(pendingImageAnchors);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("richHtmlPaste + imagePaste — one clipboard carrying HTML and an image file", () => {
  it("keeps the caption when the image file is zero bytes", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view, post } = mount("");
    firePasteAt(view.contentDOM, {
      html: CAPTION_HTML,
      files: [{ type: "image/png", file: new File([], "empty.png", { type: "image/png" }) }],
    });
    expect(view.state.doc.toString()).toBe("caption\n");
    expect(anchors(view)).toEqual([]);
    expect(imageWrites(post)).toEqual([]);
    view.destroy();
  });

  it("keeps the caption when the host refuses the image (webview accepts, host replies null)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view, paste, post } = mount("");
    firePasteAt(view.contentDOM, { html: CAPTION_HTML, files: IMAGE_FILE });
    await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
    const [{ requestId }] = imageWrites(post);
    paste.resolve(view, requestId, null);
    expect(view.state.doc.toString()).toBe("caption\n");
    expect(anchors(view)).toEqual([]);
    view.destroy();
  });

  it("keeps the caption and the accepted images when the aggregate cap drops a later file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view, post } = mount("");
    const files = Array.from({ length: 5 }, () => ({
      type: "image/png",
      file: sizedImageFile(MAX_IMAGE_BYTES),
    }));
    firePasteAt(view.contentDOM, { html: CAPTION_HTML, files });
    expect(view.state.doc.toString()).toBe("caption\n");
    const head = view.state.selection.main.head;
    expect(head).toBe(8);
    expect(anchors(view).map((p) => p.anchor)).toEqual([head, head, head, head]);
    await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(4));
    view.destroy();
  });

  it("inserts the caption AND the image link on success, the image after the caption", async () => {
    const { view, paste, post } = mount("intro\n");
    firePasteAt(view.contentDOM, { html: CAPTION_HTML, files: IMAGE_FILE });
    expect(view.state.doc.toString()).toBe("intro\n\ncaption\n");
    const head = view.state.selection.main.head;
    expect(head).toBe(15);
    expect(anchors(view)).toEqual([{ requestId: expect.any(String), anchor: head }]);
    await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
    paste.resolve(view, imageWrites(post)[0].requestId, "assets/a.png");
    expect(view.state.doc.toString()).toBe("intro\n\ncaption\n![](assets/a.png)\n");
    expect(anchors(view)).toEqual([]);
    view.destroy();
  });

  it("KNOWN RESIDUAL: undoing the caption does not cancel the pending image — it still lands at the insert position", async () => {
    // Pinned, not endorsed: the anchor is a mapped position, not part of the
    // caption's history event. Closing this belongs to the PASTE-03
    // clipboard-arbitration work; update this test with that change.
    const { view, paste, post } = mount("intro\n");
    firePasteAt(view.contentDOM, { html: CAPTION_HTML, files: IMAGE_FILE });
    expect(view.state.doc.toString()).toBe("intro\n\ncaption\n");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("intro\n");
    expect(anchors(view)).toEqual([{ requestId: expect.any(String), anchor: 6 }]);
    await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
    paste.resolve(view, imageWrites(post)[0].requestId, "assets/a.png");
    expect(view.state.doc.toString()).toBe("intro\n![](assets/a.png)\n");
    expect(anchors(view)).toEqual([]);
    view.destroy();
  });

  it("inserts exactly one copy of the caption when text/plain rides along too", async () => {
    const { view, post } = mount("");
    firePasteAt(view.contentDOM, { html: CAPTION_HTML, text: "caption", files: IMAGE_FILE });
    expect(view.state.doc.toString()).toBe("caption\n");
    expect(anchors(view)).toHaveLength(1);
    await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
    view.destroy();
  });

  it("inserts a syntax-bearing conversion and still queues the image", async () => {
    const { view, post } = mount("");
    firePasteAt(view.contentDOM, { html: "<p><strong>bold</strong></p>", files: IMAGE_FILE });
    expect(view.state.doc.toString()).toBe("**bold**\n");
    expect(anchors(view)).toEqual([{ requestId: expect.any(String), anchor: 9 }]);
    await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
    view.destroy();
  });

  it("inserts nothing and queues no image in a read-only editor", () => {
    const { view, post } = mount("intro\n", false);
    const event = firePasteAt(view.contentDOM, { html: CAPTION_HTML, files: IMAGE_FILE });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("intro\n");
    expect(anchors(view)).toEqual([]);
    expect(imageWrites(post)).toEqual([]);
    view.destroy();
  });
});
