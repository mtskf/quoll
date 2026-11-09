// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../../../src/shared/protocol.js";
import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
import { createImageFileTransport } from "../../../src/webview/cm/image/image-paste.js";
import { createClipboardPaste } from "../../../src/webview/cm/paste/clipboard-paste.js";
import { pendingPasteOperations } from "../../../src/webview/cm/paste/paste-operation.js";
import {
  fireDragOverAt,
  fireDropAt,
  firePasteAt,
  IMAGE_FILE,
} from "../helpers/clipboard-double.js";
import { imageWrites, sizedImageFile } from "../helpers/image-paste-doubles.js";

const views: EditorView[] = [];
function mount(doc = "", canWrite = true, extras: Extension = []) {
  const post = vi.fn<(message: WebviewToHost) => void>();
  const paste = createClipboardPaste({ canWrite: () => canWrite, post, onFailure: vi.fn() });
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [paste.extension, extras] }),
  });
  views.push(view);
  return { view, paste, post };
}
// The 8-byte PNG signature plus the head of its IHDR chunk. Real bytes rather than
// text so a decode of the posted payload can PROVE the file survived the data-URL
// round trip: a split that kept the `data:image/png;base64,` prefix, or that sliced
// one byte off either side, cannot produce these back.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const pngFile = (): File => new File([PNG_BYTES], "shot.png", { type: "image/png" });

const decodeBase64 = (data: string): Uint8Array =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

/** The unit the production SIZE thresholds are expressed in. (The per-event COUNT
 *  cap is a number of files, not a byte size — see the per-event caps describe.) */
const MIB = 1024 * 1024;

// A FileReader stand-in, installed per test, so the async read can be driven to a
// chosen outcome — including outcomes a real FileReader will not produce on demand
// (onerror, a non-string result). It implements exactly the five members production
// touches; a fuller fake would only be more surface to drift.
class StubFileReader
  implements Pick<FileReader, "result" | "error" | "onload" | "onerror" | "readAsDataURL">
{
  result: string | ArrayBuffer | null = null;
  // The one member of the real FileReader contract this stub grew for the
  // onerror path: `reader.error` is the ONLY description of the failure the
  // browser gives us, and the handler must pass it on rather than discard it.
  error: DOMException | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(): void {
    driveRead(this);
  }
}
let driveRead: (reader: StubFileReader) => void = () => {};

function stubFileReader(drive: (reader: StubFileReader) => void): void {
  driveRead = drive;
  vi.stubGlobal("FileReader", StubFileReader);
}

/** Install a reader that starts but never completes — the form every test wants
 *  when its whole observable is the SYNCHRONOUS pending anchor. Deliberate rather
 *  than incidental: a read that never finishes cannot outlive `view.destroy()` and
 *  post into a torn-down view. */

/** happy-dom has no layout engine, so `view.posAtCoords` reaches through an
 *  undefined client rect and THROWS at SOME coordinates rather than returning a
 *  position — `fireDropAt`'s default `{0,0}` among them (measured; `{12,34}` on
 *  these same mounts returns a position, so this is coordinate-dependent, not
 *  "always throws"). Applied to READ-ONLY drops too, and that is the point: with
 *  the `canWrite()` gate deleted the handler falls through to `posAtCoords`, which
 *  at the default coords would throw and queue no anchor, so an unstubbed read-only
 *  test would stay green for entirely the wrong reason. */
function stubDropPos(view: EditorView, pos: number | null) {
  return vi.spyOn(view, "posAtCoords").mockReturnValue(pos);
}

afterEach(() => {
  vi.unstubAllGlobals();
  views.forEach((view) => {
    view.destroy();
  });
  views.length = 0;
  vi.restoreAllMocks();
  driveRead = () => {};
});

it("transport settles callbacks without inserting", async () => {
  const { view, post } = mount("hello");
  const transport = createImageFileTransport({ post });
  const settled = vi.fn();
  transport.start([pngFile()], settled);
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  expect(decodeBase64(imageWrites(post)[0].data)).toEqual(PNG_BYTES);
  transport.resolve(imageWrites(post)[0].requestId, "assets/a.png");
  expect(settled).toHaveBeenCalledWith(0, "assets/a.png");
  expect(view.state.doc.toString()).toBe("hello");
});
it("reverse replies preserve clipboard order in one replacement", async () => {
  const { view, paste, post } = mount("old");
  view.dispatch({ selection: { anchor: 0, head: 3 } });
  firePasteAt(view.contentDOM, { files: [...IMAGE_FILE, ...IMAGE_FILE] });
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(2));
  const [a, b] = imageWrites(post);
  expect(a.requestId).not.toBe(b.requestId);
  paste.resolve(b.requestId, "assets/b.png");
  expect(view.state.doc.toString()).toBe("old");
  paste.resolve(a.requestId, "assets/a.png");
  expect(view.state.doc.toString()).toBe("![](assets/a.png)\n![](assets/b.png)\n");
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});
it("requestIds cannot collide across webview sessions", async () => {
  const a = mount();
  const b = mount();
  firePasteAt(a.view.contentDOM, { files: IMAGE_FILE });
  firePasteAt(b.view.contentDOM, { files: IMAGE_FILE });
  await vi.waitFor(() => {
    expect(imageWrites(a.post)).toHaveLength(1);
    expect(imageWrites(b.post)).toHaveLength(1);
  });
  expect(imageWrites(a.post)[0].requestId).not.toBe(imageWrites(b.post)[0].requestId);
});
it.each([false, true])("reseed retains ack and cancels changed content (%s)", async (changed) => {
  const { view, paste, post } = mount("old");
  firePasteAt(view.contentDOM, { files: IMAGE_FILE });
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  view.dispatch({
    ...(changed ? { changes: { from: 0, to: 3, insert: "new" } } : {}),
    annotations: hostDocumentReseed.of(true),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  paste.resolve(imageWrites(post)[0].requestId, "assets/a.png");
  expect(view.state.doc.toString()).toBe(changed ? "new" : "![](assets/a.png)\nold");
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});
it.each([0, 2, null])("drop uses its coordinate, falling back to selection (%s)", async (pos) => {
  const { view, paste, post } = mount("abcd");
  view.dispatch({ selection: { anchor: 1, head: 3 } });
  stubDropPos(view, pos);
  const event = fireDropAt(view.contentDOM, { files: IMAGE_FILE });
  expect(event.defaultPrevented).toBe(true);
  const from = pos ?? 3;
  expect(view.state.field(pendingPasteOperations)[0]).toMatchObject({ from, to: from });
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  paste.resolve(imageWrites(post)[0].requestId, "assets/a.png");
  expect(view.state.doc.toString()).toBe(
    `${"abcd".slice(0, from)}${from ? "\n" : ""}![](assets/a.png)\n${"abcd".slice(from)}`
  );
});
it("file drag permits drop; ordinary drag and drop delegate", () => {
  const { view, post } = mount("old");
  expect(fireDragOverAt(view.contentDOM, { files: IMAGE_FILE }).defaultPrevented).toBe(true);
  fireDropAt(view.contentDOM, { text: "" });
  expect(imageWrites(post)).toEqual([]);
});
it("read-only paste and drop start no reads or posts", () => {
  const { view, post } = mount("old", false);
  stubDropPos(view, 0);
  expect(firePasteAt(view.contentDOM, { files: IMAGE_FILE }).defaultPrevented).toBe(true);
  expect(fireDropAt(view.contentDOM, { files: IMAGE_FILE }).defaultPrevented).toBe(true);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
  expect(imageWrites(post)).toEqual([]);
});
it.each([
  "read",
  "abort",
  "post",
  "malformed",
])("local transfer failure settles slot (%s)", (failure) => {
  stubFileReader((reader) => {
    if (failure === "read") {
      reader.onerror?.();
      return;
    }
    if (failure === "abort") {
      (reader as unknown as { onabort: () => void }).onabort();
      return;
    }
    reader.result = failure === "malformed" ? new ArrayBuffer(0) : "data:image/png;base64,eA==";
    reader.onload?.();
  });
  const post = vi.fn(() => {
    throw new Error("post failed");
  });
  const settled = vi.fn();
  createImageFileTransport({ post }).start([pngFile()], settled);
  expect(settled).toHaveBeenCalledExactlyOnceWith(0, null);
});
it("per-file refusal skips oversized file and preserves later slot", () => {
  stubFileReader((reader) => {
    reader.result = "data:image/png;base64,eA==";
    reader.onload?.();
  });
  const post = vi.fn<(message: WebviewToHost) => void>();
  const settled = vi.fn();
  createImageFileTransport({ post }).start([sizedImageFile(20 * MIB), pngFile()], settled);
  expect(settled).toHaveBeenCalledWith(0, null);
  expect(imageWrites(post)).toHaveLength(1);
});
it("aggregate ceiling accepts exact boundary then stops", () => {
  stubFileReader((reader) => {
    reader.result = "data:image/png;base64,eA==";
    reader.onload?.();
  });
  const post = vi.fn<(message: WebviewToHost) => void>();
  const settled = vi.fn();
  createImageFileTransport({ post }).start(
    [...Array.from({ length: 4 }, () => sizedImageFile(MAX_IMAGE_BYTES)), pngFile(), pngFile()],
    settled
  );
  expect(imageWrites(post)).toHaveLength(4);
  expect(settled.mock.calls).toEqual([
    [4, null],
    [5, null],
  ]);
});
it.each([
  "encoded",
  "count",
  "aggregate",
])("transport ceiling refusal settles without posting (%s)", (ceiling) => {
  stubFileReader((reader) => {
    reader.result = "data:image/png;base64,eA==";
    reader.onload?.();
  });
  const post = vi.fn<(message: WebviewToHost) => void>();
  const settled = vi.fn();
  const transport = createImageFileTransport({ post });
  const files =
    ceiling === "encoded"
      ? [sizedImageFile(20 * MIB)]
      : ceiling === "count"
        ? Array.from({ length: 17 }, pngFile)
        : Array.from({ length: 6 }, () => sizedImageFile(8 * MIB));
  transport.start(files, settled);
  const accepted = ceiling === "encoded" ? 0 : ceiling === "count" ? 16 : 5;
  expect(imageWrites(post)).toHaveLength(accepted);
  expect(settled.mock.calls).toEqual([[accepted, null]]);
});

it("zero-byte candidate reaches host as empty base64", async () => {
  const post = vi.fn<(message: WebviewToHost) => void>();
  const settled = vi.fn();
  const transport = createImageFileTransport({ post });
  transport.start([new File([], "empty", { type: "image/png" })], settled);
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  expect(imageWrites(post)[0]).toEqual({
    protocol: PROTOCOL_VERSION,
    type: "image-write",
    requestId: expect.any(String),
    data: "",
  });
  expect(settled).not.toHaveBeenCalled();
  transport.resolve(imageWrites(post)[0].requestId, null);
  expect(settled).toHaveBeenCalledWith(0, null);
});

it.each([
  "application/pdf",
  "",
])("non-image MIME candidate reaches host byte decision (%s)", async (type) => {
  const post = vi.fn<(message: WebviewToHost) => void>();
  const settled = vi.fn();
  const transport = createImageFileTransport({ post });
  transport.start([new File([PNG_BYTES], "untyped", { type })], settled);
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  const request = imageWrites(post)[0];
  expect(decodeBase64(request.data)).toEqual(PNG_BYTES);
  transport.resolve(request.requestId, "./assets/accepted.png");
  expect(settled).toHaveBeenCalledWith(0, "./assets/accepted.png");
});
