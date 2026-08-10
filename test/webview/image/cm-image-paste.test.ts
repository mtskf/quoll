// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ImageWriteMessage,
  isWebviewToHost,
  MAX_IMAGE_BYTES,
  PROTOCOL_VERSION,
  type WebviewToHost,
} from "../../../src/shared/protocol.js";
import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
import {
  addPendingAnchor,
  createImagePasteDrop,
  isIngestibleImageItem,
  pendingImageAnchors,
} from "../../../src/webview/cm/image/image-paste.js";
import {
  fireDragOverAt,
  fireDropAt,
  firePasteAt,
  IMAGE_FILE,
  makeClipboardData,
} from "../helpers/clipboard-double.js";

function mount(doc: string, canWrite = true) {
  const post = vi.fn<(message: WebviewToHost) => void>();
  const paste = createImagePasteDrop({ canWrite: () => canWrite, post });
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [paste.extension] }),
  });
  return { view, paste, post };
}

// No hand-written `m is ImageWriteMessage` on the filter: TypeScript takes a written
// predicate on trust and never checks it against the body, so a wrong one compiles.
// Left off, TS infers the narrowing and the declared return type verifies it.
function imageWrites(post: ReturnType<typeof mount>["post"]): ImageWriteMessage[] {
  return post.mock.calls.map(([message]) => message).filter((m) => m.type === "image-write");
}

const anchorIds = (view: EditorView): string[] =>
  view.state.field(pendingImageAnchors).map((p) => p.requestId);

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

/** A file that REPORTS `bytes` while its content stays one byte. Both size caps are
 *  decided from `file.size` before the FileReader ever runs, so allocating a real
 *  10–15 MiB buffer per file would only slow the suite down. */
function sizedImageFile(bytes: number): File {
  const file = new File(["x"], "f", { type: "image/png" });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}

// A FileReader stand-in, installed per test, so the async read can be driven to a
// chosen outcome — including outcomes a real FileReader will not produce on demand
// (onerror, a non-string result). It implements exactly the four members production
// touches; a fuller fake would only be more surface to drift.
class StubFileReader
  implements Pick<FileReader, "result" | "onload" | "onerror" | "readAsDataURL">
{
  result: string | ArrayBuffer | null = null;
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
const stubReadThatNeverCompletes = () => stubFileReader(() => {});

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
  vi.restoreAllMocks();
  driveRead = () => {};
});

describe("pendingImageAnchors", () => {
  it("maps an anchor through insertions, staying AFTER text inserted at it", () => {
    const { view } = mount("hello");
    const anchorOne = () =>
      view.state.field(pendingImageAnchors).find((p) => p.requestId === "1")?.anchor;
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 2 }) });
    view.dispatch({ changes: { from: 0, insert: "XX" } });
    expect(anchorOne()).toBe(4);
    // Association 1, and the second assertion is what pins it: an insertion landing
    // EXACTLY on the anchor must leave the anchor after it. With -1 the anchor stays
    // put, so a keystroke at the caret while the host round-trip is in flight would
    // land the image link above the character the user just typed.
    view.dispatch({ changes: { from: 4, insert: "YY" } });
    expect(anchorOne()).toBe(6);
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
    // The caret ends up PAST the inserted block, so typing continues below the
    // image rather than in front of it.
    expect(view.state.selection.main.head).toBe(22);
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
  });

  it("inserts at a line start without prepending a blank line", () => {
    // The other branch of the mid-line ternary, and the only one every other test
    // here misses (they all anchor at 1). A regression to an unconditional "\n"
    // silently prepends a blank line to every image pasted at a line start — byte
    // noise invisible in the WYSIWYG surface, found only in `git diff`.
    const { view, paste } = mount("ab");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 0 }) });
    paste.resolve(view, "1", "./assets/x.png");
    expect(view.state.doc.toString()).toBe("![](./assets/x.png)\nab");
    expect(view.state.selection.main.head).toBe(20);
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

  it("ignores an unknown requestId while another anchor is still pending", () => {
    // The anchor seeded here is what makes this a test of the ID MATCH rather than
    // of the empty-queue case: on an empty field `find(...)` and `[0]` are both
    // undefined, so the guard reads as "correct" while ignoring the requestId
    // entirely. This is the terminus of the sessionNonce design — a late reply from
    // a previous webview session must be a no-op, not a resolve of whatever anchor
    // happens to be first in the queue, which would write one image's path onto
    // another image's position.
    const { view, paste } = mount("ab");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 1 }) });
    paste.resolve(view, "nope", "./assets/x.png");
    // The document is the hazard itself; the surviving entry is the other half —
    // the real anchor must still be waiting for its own reply.
    expect(view.state.doc.toString()).toBe("ab");
    expect(view.state.field(pendingImageAnchors)).toEqual([{ requestId: "1", anchor: 1 }]);
  });

  it("logs and clears the anchor when the insert throws on a stale position", () => {
    // The failure the whole guard exists for, raised WITHOUT a mock: an anchor past
    // the doc end makes `doc.lineAt` throw a real RangeError. It throws BEFORE the
    // dispatch, which is why the guard cannot sit around the dispatch alone — there
    // it escapes into the shell's message handler instead.
    //
    // Everything asserted here is downstream of one fact: the host has ALREADY
    // written the image by the time resolve runs. So a failure must leave a LOUD
    // orphan (logged, no pending entry) rather than a silent one — a leaked entry
    // pins a dead anchor and makes the user's re-paste read as a duplicate.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { view, paste } = mount("ab");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 99 }) });

    expect(() => paste.resolve(view, "1", "./assets/x.png")).not.toThrow();
    expect(error.mock.calls).toEqual([
      ["[quoll] failed to insert pasted image link", expect.any(RangeError)],
    ]);
    expect(view.state.doc.toString()).toBe("ab");
    expect(view.state.field(pendingImageAnchors)).toEqual([]);
    view.destroy();
  });

  it("still logs when even the clearing dispatch fails after a teardown", () => {
    // The other end of the same guard: the view dies between the shell's null-check
    // and the dispatch, so BOTH the insert and the follow-up clear throw. The anchor
    // then dies with the view (clearPending swallows it), so the log is the only
    // observable left — and it is the one that must survive, since without it a
    // half-completed paste leaves no trace anywhere.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { view, paste } = mount("ab");
    view.dispatch({ effects: addPendingAnchor.of({ requestId: "1", anchor: 1 }) });
    // Raised deliberately: CM 6.43 does not throw on dispatch to a destroyed view
    // (see the clearPending test below for the measurement). The contract is pinned
    // for the future, not for today's CM.
    const dispatch = vi.spyOn(view, "dispatch").mockImplementation(() => {
      throw new Error("dispatch on a destroyed view");
    });

    expect(() => paste.resolve(view, "1", "./assets/x.png")).not.toThrow();
    expect(error.mock.calls).toEqual([
      ["[quoll] failed to insert pasted image link", expect.any(Error)],
    ]);
    // Twice: the insert, then the clear it attempts anyway. One call would mean the
    // catch returned without trying to clear.
    expect(dispatch).toHaveBeenCalledTimes(2);
    view.destroy();
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
  // Two observables, and each covers what the other cannot. An anchor is queued
  // SYNCHRONOUSLY when a file is submitted, so it pins ingestion (the async post
  // rides a FileReader and is pinned in the next describe). But an anchor count of
  // 0 is equally true of a decline and of a consume-without-ingesting, so every
  // decline test also asserts the DOCUMENT: on a decline CM core's builtin paste
  // handler runs next and inserts the text flavour; on a consume it never runs.
  // `defaultPrevented` separates neither — CM's builtin returns true for any truthy
  // clipboardData and `runHandlers` preventDefaults on a true return, so it is true
  // with or without this extension.
  it("ingests a paste carrying an image file beside text flavours, at the selection head", () => {
    stubReadThatNeverCompletes();
    const { view } = mount("abcd");
    view.dispatch({ selection: { anchor: 4, head: 1 } });
    firePasteAt(view.contentDOM, { files: IMAGE_FILE, html: "<p>x</p>", text: "x" });
    // The anchor's VALUE, not just its existence: the paste path derives it from
    // the selection HEAD, and the selection is backwards and non-empty so neither a
    // hard-coded 0 nor `.anchor` (4) can pass. (The drop path's twin is in the drop
    // describe.)
    expect(view.state.field(pendingImageAnchors)).toEqual([
      { requestId: expect.any(String), anchor: 1 },
    ]);
    view.destroy();
  });

  it("derives the paste anchor from the head of a FORWARD selection too", () => {
    // A second FIXTURE rather than a second assertion on the one above, because no
    // single selection shape can separate `head` from both of its neighbours: CM
    // derives `from = min(anchor, head)`, so on the backwards selection above
    // `from === head === 1` and a regression to `.from` reads identically there.
    // Forward is the shape where all three diverge — anchor/from 1, head/to 4 — so
    // only here does `.from` produce the wrong anchor. (Drop's twin is below.)
    stubReadThatNeverCompletes();
    const { view } = mount("abcd");
    view.dispatch({ selection: { anchor: 1, head: 4 } });
    firePasteAt(view.contentDOM, { files: IMAGE_FILE, text: "x" });
    expect(view.state.field(pendingImageAnchors)).toEqual([
      { requestId: expect.any(String), anchor: 4 },
    ]);
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
    firePasteAt(view.contentDOM, { files, text: "ZZ" });
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    // Declined, not consumed. The caret sits at 0, so CM core's insert of the text
    // flavour is the difference: a handler that preventDefaults and returns true
    // here leaves the doc "ab" — the "every text paste silently vanishes"
    // regression this module exists to avoid.
    expect(view.state.doc.toString()).toBe("ZZab");
    view.destroy();
  });

  it("declines a text-only paste (its kind:'string' items are not files)", () => {
    const { view } = mount("ab");
    firePasteAt(view.contentDOM, { html: "<p>x</p>", text: "ZZ" });
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    expect(view.state.doc.toString()).toBe("ZZab");
    view.destroy();
  });

  it("leaves a trace when it drops a zero-byte image", () => {
    // The one clipboard shape where declining is invisible from the document: the
    // shared predicate never looks at size, so richHtmlPaste has already deferred;
    // this handler preventDefaults, skips the file and returns true. Nothing is
    // inserted and CM's plain-text fallback is suppressed, so the console line is
    // the only evidence the paste ever happened. All three refusals in the loop are
    // asserted by TEXT, because a warn COUNT makes them interchangeable and a
    // swapped refusal would go unnoticed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { view } = mount("ab");
    const empty = new File([], "f", { type: "image/png" });
    firePasteAt(view.contentDOM, { files: [{ type: "image/png", file: empty }], text: "ZZ" });
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("zero bytes"));
    // The suppression itself: the text flavour does NOT reach the document. Recorded
    // rather than pinned — the handler's unconditional `preventDefault` runs before
    // every refusal, so no mutation of the refusals can flip this line.
    expect(view.state.doc.toString()).toBe("ab");
    view.destroy();
  });

  it("swallows an image paste on a read-only doc without queueing an anchor", () => {
    const { view } = mount("ab", false);
    firePasteAt(view.contentDOM, { files: IMAGE_FILE, text: "ZZ" });
    // The anchor count is the pinning assertion: delete the `canWrite()` gate and
    // the file is submitted, queueing one. The doc records the rest of the contract
    // — the event is consumed, so CM's plain-text fallback never runs. (`mount(doc,
    // false)` gates createImagePasteDrop only; it does not set EditorState.readOnly,
    // so CM's own read-only short-circuit is not what produces this.)
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    expect(view.state.doc.toString()).toBe("ab");
    view.destroy();
  });
});

describe("imagePaste — the image-write post", () => {
  // The ingestion tests above stop at the pending anchor, which is queued
  // SYNCHRONOUSLY. Everything past it — the FileReader, the data-URL split, the
  // post itself — is the async half, and nothing asserted it: a `post` spy existed
  // but was never read. A split that shipped the `data:` prefix through, or that
  // came back empty, would leave every one of those tests green while every real
  // paste failed host-side validation.
  it("posts the file's own bytes as prefix-stripped base64", async () => {
    const { view, post } = mount("ab");
    firePasteAt(view.contentDOM, { files: [{ type: "image/png", file: pngFile() }] });

    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [message] = imageWrites(post);
    expect(message.protocol).toBe(PROTOCOL_VERSION);
    // The prefix must be gone, and the payload must decode back to the exact file
    // bytes — magic bytes included. Asserted as two facts because they fail
    // differently: a kept prefix is a wire-format bug, a shifted slice is a decode
    // bug, and only the second survives a `not.toMatch(/^data:/)` on its own.
    expect(message.data).not.toMatch(/^data:/);
    expect(Array.from(decodeBase64(message.data))).toEqual(Array.from(PNG_BYTES));
    // The host's own boundary validator is the real acceptance test for this
    // message — pin it here rather than restating its bounds.
    expect(isWebviewToHost(message)).toBe(true);
    // The post carries the requestId of the anchor still waiting on the reply;
    // without this the two halves could drift and every image would resolve to the
    // unknown-requestId no-op.
    expect(anchorIds(view)).toEqual([message.requestId]);
    view.destroy();
  });

  it("mints a distinct requestId per file and resolves the pair in completion order", async () => {
    const { view, paste, post } = mount("ab");
    view.dispatch({ selection: { anchor: 1 } });
    firePasteAt(view.contentDOM, {
      files: [
        { type: "image/png", file: pngFile() },
        { type: "image/png", file: pngFile() },
      ],
    });

    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const ids = imageWrites(post).map((m) => m.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(anchorIds(view).sort()).toEqual([...ids].sort());
    // Both anchors start on the same position, so the ORDER is decided by the
    // mapping: resolving the first maps the second anchor past the text just
    // inserted (association 1), landing the pair in completion order instead of
    // stacking in reverse. The second lands on a line start, so it also exercises
    // resolve()'s no-leading-newline branch from the far side.
    paste.resolve(view, ids[0], "./assets/one.png");
    paste.resolve(view, ids[1], "./assets/two.png");
    expect(view.state.doc.toString()).toBe("a\n![](./assets/one.png)\n![](./assets/two.png)\nb");
    view.destroy();
  });

  it("mints requestIds that cannot collide across webview sessions", () => {
    // Each createImagePasteDrop is one webview session, and its counter restarts
    // from zero. Without the per-session nonce both sessions mint the same first
    // id, so a late image-write-result from the PREVIOUS session resolves this
    // session's anchor and writes the wrong image path into the document. Two live
    // instances is the only way to observe the nonce at all.
    stubReadThatNeverCompletes();
    const first = mount("ab");
    const second = mount("ab");
    firePasteAt(first.view.contentDOM, { files: IMAGE_FILE });
    firePasteAt(second.view.contentDOM, { files: IMAGE_FILE });

    expect(anchorIds(first.view)).toHaveLength(1);
    expect(anchorIds(second.view)).not.toEqual(anchorIds(first.view));
    first.view.destroy();
    second.view.destroy();
  });

  it.each([
    ["a non-string result", new ArrayBuffer(8)],
    ["a data URL whose base64 payload is empty", "data:image/png;base64,"],
    ["a result with no comma to split on", "not-a-data-url"],
  ])("clears the pending anchor without posting on %s", (_label, result) => {
    stubFileReader((reader) => {
      reader.result = result;
      reader.onload?.();
    });
    const { view, post } = mount("ab");
    firePasteAt(view.contentDOM, { files: IMAGE_FILE });

    expect(post).not.toHaveBeenCalled();
    // Cleared, not merely never-added: the anchor is queued before the read starts,
    // so a missing clear leaks it and the next reseed-free resolve could land an
    // unrelated image link on it.
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    view.destroy();
  });

  it("clears the pending anchor and logs when the read itself fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFileReader((reader) => reader.onerror?.());
    const { view, post } = mount("ab");
    firePasteAt(view.contentDOM, { files: IMAGE_FILE });

    expect(post).not.toHaveBeenCalled();
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    // There is no webview toast channel for this path, so the console line is the
    // only trace a failed read leaves anywhere. Pinned as the COMPLETE call list,
    // by text AND by exhaustion: CodeMirror swallows an exception thrown inside a
    // domEventHandler (`bindHandler` → `logException`) and reports it as a further
    // console.error, which a text-only `toHaveBeenCalledWith` would not notice.
    expect(error.mock.calls).toEqual([["[quoll] failed to read pasted image"]]);
    view.destroy();
  });

  it("clears the pending anchor when the post is refused by the transport", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // mount()'s own `post` spy, not a hand-rolled EditorView: createImagePasteDrop
    // captures it via opts.post, so mockImplementation reaches the same closure —
    // and a future change to mount() cannot silently skip this test.
    const { view, post } = mount("ab");
    post.mockImplementation(() => {
      throw new Error("panel disposed mid-post");
    });
    firePasteAt(view.contentDOM, { files: [{ type: "image/png", file: pngFile() }] });

    // safePostMessage swallows the throw and reports false; the anchor must not
    // outlive a message the host never received. Observed through the post call AND
    // the complete console.error list — the combination that separates this path
    // from a read failure and from a crash logged after it.
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(error.mock.calls).toEqual([
      ["[quoll] postMessage(image-write) failed", expect.any(Error)],
    ]);
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    view.destroy();
  });

  it("swallows a clearPending dispatch that fails after the view was destroyed", () => {
    const readers: StubFileReader[] = [];
    stubFileReader((reader) => {
      readers.push(reader);
    });
    const { view, post } = mount("ab");
    firePasteAt(view.contentDOM, { files: IMAGE_FILE });
    expect(view.state.field(pendingImageAnchors).length).toBe(1);

    view.destroy();
    // CM 6.43 does NOT throw on dispatch to a destroyed view — EditorView.update
    // early-returns on `this.destroyed` (measured: no throw, and the state update is
    // even applied). So destroying alone cannot exercise clearPending's catch; the
    // throw is raised DELIBERATELY here to pin the contract itself. Do not read this
    // as "CM throws": the point is the future, where a real browser or a CM bump
    // that restores the throw must not turn a tab closed mid-read into an
    // unhandled rejection escaping the FileReader callback.
    const dispatch = vi.spyOn(view, "dispatch").mockImplementation(() => {
      throw new Error("dispatch on a destroyed view");
    });
    const reader = readers[0];
    reader.result = "not-a-data-url"; // no comma to split on → clearPending
    expect(() => reader.onload?.()).not.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("imagePaste — per-event caps", () => {
  // The two SIZE caps are decided from `file.size` BEFORE the read; the COUNT cap
  // is decided from `files.length` before the loop runs at all, so its warn names a
  // number of discarded files rather than one file. Either way nothing is read, so
  // the pending anchor count is the complete observable and these tests can stay
  // synchronous — hence `stubReadThatNeverCompletes` throughout.

  it("drops a grossly oversized image before reading it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    // 5 MiB past the reject threshold puts it 1 MiB past the transfer ceiling
    // (reject + 4 MiB of headroom), i.e. into the band the webview drops itself
    // rather than forwarding for a precise host-side toast.
    const huge = sizedImageFile(MAX_IMAGE_BYTES + 5 * MIB);
    firePasteAt(view.contentDOM, { files: [{ type: "image/png", file: huge }] });

    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds transfer ceiling"));
    view.destroy();
  });

  it("still forwards an image inside the transfer-headroom band", () => {
    // The band ABOVE the reject threshold but below the transfer ceiling has to
    // reach the host, which answers with a precise too-large toast — protocol.ts
    // sizes MAX_IMAGE_DATA_LENGTH from the ceiling for exactly this reason. Gating
    // on MAX_IMAGE_BYTES instead would silently drop the whole band, degrading that
    // toast into a console.warn nobody sees.
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    const slightlyOver = sizedImageFile(MAX_IMAGE_BYTES + MIB);
    firePasteAt(view.contentDOM, { files: [{ type: "image/png", file: slightlyOver }] });

    expect(view.state.field(pendingImageAnchors).length).toBe(1);
    view.destroy();
  });

  it("skips — rather than stops at — a per-file refusal, so later images still land", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    // The twin of the aggregate-cap test below, and the reason it takes its own
    // fixture: `handle()` has THREE refusals, and only the aggregate one is meant to
    // `break`. The two per-file ones must `continue` so one bad file does not
    // discard the rest of the paste. Every other refusal test here is a single-file
    // fixture, where `continue` and `break` are indistinguishable — a valid file
    // has to sit BEHIND a refused one for the difference to become observable.
    const empty = new File([], "f", { type: "image/png" });
    firePasteAt(view.contentDOM, {
      files: [
        { type: "image/png", file: empty }, // refused: zero bytes
        { type: "image/png", file: sizedImageFile(MAX_IMAGE_BYTES + 5 * MIB) }, // refused: over the ceiling
        { type: "image/png" }, // 1 byte — must still be ingested
      ],
    });

    expect(view.state.field(pendingImageAnchors).length).toBe(1);
    // Both refusals are named, so the two branches stay distinguishable from each
    // other as well as from the aggregate cap.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("zero bytes"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds transfer ceiling"));
    view.destroy();
  });

  it("stops — rather than skips — at the per-event aggregate byte cap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    // Every file clears the per-file ceiling on its own, so only the aggregate can
    // refuse any of them — the cap that exists so a multi-file drop cannot queue
    // 16 × the transfer ceiling of base64 at once.
    //
    // Sizes are deliberately MIXED, and that is this test's whole job. 10+10+10+9
    // reaches 39 MiB, the fifth 10 MiB file would exceed the 40 MiB cap, and the
    // trailing 1 MiB file would still FIT. Production documents `break`, so that
    // trailing file must NOT be queued: with `continue` the count is 5. The
    // uniform-size test below owns the other half — the exact boundary — because no
    // running total here lands ON the cap. Neither fixture can do both.
    const files = [10, 10, 10, 9, 10, 1].map((size) => ({
      type: "image/png",
      file: sizedImageFile(size * MIB),
    }));
    firePasteAt(view.contentDOM, { files });

    expect(view.state.field(pendingImageAnchors).length).toBe(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("aggregate byte cap"));
    view.destroy();
  });

  it("accepts the file that lands exactly ON the aggregate byte cap (pins > over >=)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    // Five files of exactly MAX_IMAGE_BYTES: the fourth brings the running total to
    // 30 + 10 = 40 MiB, exactly the cap. `>` accepts it (4 queued), `>=` refuses it
    // (3) — the comparison the mixed fixture above cannot see.
    const files = Array.from({ length: 5 }, () => ({
      type: "image/png",
      file: sizedImageFile(MAX_IMAGE_BYTES),
    }));
    firePasteAt(view.contentDOM, { files });

    expect(view.state.field(pendingImageAnchors).length).toBe(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("aggregate byte cap"));
    view.destroy();
  });

  it("ingests at most 16 files from one event, and says how many it dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    // One byte each, so the count cap is the only thing that can bite. Twenty
    // rather than the minimal 17 so the reported COUNT (4) is distinguishable from
    // both the overflow-of-one case and from any hard-coded number.
    const files = Array.from({ length: 20 }, () => ({ type: "image/png" }));
    firePasteAt(view.contentDOM, { files });

    expect(view.state.field(pendingImageAnchors).length).toBe(16);
    // The refusal this cap used to make silently: the overflow is discarded whole,
    // so without a line here dropping 20 images inserts 16 and tells the user
    // nothing, anywhere. Pinned by TEXT like the other three refusals (a warn COUNT
    // would make them interchangeable), and the dropped count is pinned too because
    // it is the only part of the message a reader can act on.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("count cap"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped 4 image"));
    view.destroy();
  });

  it("stays silent about the count cap on an event that fits exactly", () => {
    // The boundary `>` vs `>=`: at exactly 16 files nothing is discarded, so a warn
    // here would cry wolf on every full-but-legal paste. No other test in this file
    // sits on the cap, so without this one `>=` ships green.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    const files = Array.from({ length: 16 }, () => ({ type: "image/png" }));
    firePasteAt(view.contentDOM, { files });

    expect(view.state.field(pendingImageAnchors).length).toBe(16);
    expect(warn).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe("imagePaste — drop and dragover", () => {
  // Untested end to end until now: the drop handler shares `handle` with paste but
  // owns its own read-only gate, its own preventDefault (the one that stops the
  // browser navigating away from the document to the dropped file) and its own
  // anchor derivation.
  //
  // `defaultPrevented` discriminates here, but only for events CM's builtin does
  // NOT already claim. Measured on a bare EditorView carrying no imagePaste
  // extension: a FILE-carrying drop is already `true` (CM's `handlers.drop` returns
  // true for any dataTransfer with files, and `runHandlers` preventDefaults on a
  // true return), so the file-drop tests below pin anchors instead. A TEXT-ONLY
  // drop is `false`, and that is the entire observable of the decline path — the
  // drop handler returns before its own preventDefault on that branch. `dragover`
  // is bare-false the same way.
  it("preventDefaults a file drag so the drop event can fire, and leaves other drags alone", () => {
    const { view } = mount("ab");
    // Without the preventDefault the browser never fires `drop` at all, so this is
    // load-bearing rather than cosmetic.
    expect(fireDragOverAt(view.contentDOM, { files: IMAGE_FILE }).defaultPrevented).toBe(true);
    expect(fireDragOverAt(view.contentDOM, { text: "x" }).defaultPrevented).toBe(false);
    view.destroy();
  });

  it("declines a drop carrying no image, leaving the event to CM", () => {
    // The drop-side mirror of the paste decline tests, and it needs a different
    // observable: nothing CM does with a text drop reaches this document, so only
    // `defaultPrevented` can tell decline from consume.
    //
    // ⚠️ The `false` baseline depends on the double: CM's builtin drop handler reads
    // the LEGACY alias `dataTransfer.getData("Text")`, which `makeClipboardData`
    // deliberately does not answer (canonical note: on its `getData`), so CM declines
    // too. That much is a property of the double, not of imagePaste — but the mutant
    // this test exists to kill (consuming every non-image drop) flips it to `true`
    // either way.
    const { view } = mount("ab");
    expect(fireDropAt(view.contentDOM, { text: "x" }).defaultPrevented).toBe(false);
    view.destroy();
  });

  it("ingests an image drop at the dropped-at position", () => {
    stubReadThatNeverCompletes();
    const { view } = mount("ab");
    const posAtCoords = stubDropPos(view, 2);
    view.dispatch({ selection: { anchor: 0 } });

    fireDropAt(view.contentDOM, { files: IMAGE_FILE }, { x: 12, y: 34 });

    // The drop point, NOT the selection head (0) — pinned by driving them apart.
    expect(posAtCoords).toHaveBeenCalledWith({ x: 12, y: 34 });
    expect(view.state.field(pendingImageAnchors)).toEqual([
      { requestId: expect.any(String), anchor: 2 },
    ]);
    view.destroy();
  });

  it("falls back to the selection head when the drop point maps to no position", () => {
    stubReadThatNeverCompletes();
    const { view } = mount("abcd");
    stubDropPos(view, null);
    view.dispatch({ selection: { anchor: 4, head: 1 } });

    fireDropAt(view.contentDOM, { files: IMAGE_FILE });

    // The HEAD of a backwards non-empty selection, so neither a hard-coded 0 nor
    // `.anchor` (4) can pass.
    expect(view.state.field(pendingImageAnchors)).toEqual([
      { requestId: expect.any(String), anchor: 1 },
    ]);
    view.destroy();
  });

  it("falls back to the head of a FORWARD selection too", () => {
    // The drop-side twin of the forward-selection paste test: this fallback reads
    // `selection.main.head` at its own call site, so it needs its own forward
    // fixture to separate `head` (4) from `from` (1) — see that test for why one
    // selection shape cannot cover both aliases.
    stubReadThatNeverCompletes();
    const { view } = mount("abcd");
    stubDropPos(view, null);
    view.dispatch({ selection: { anchor: 1, head: 4 } });

    fireDropAt(view.contentDOM, { files: IMAGE_FILE });

    expect(view.state.field(pendingImageAnchors)).toEqual([
      { requestId: expect.any(String), anchor: 4 },
    ]);
    view.destroy();
  });

  it("ingests a drop at doc position 0 rather than falling back to the selection head", () => {
    // Position 0 is the ONLY drop point at which `pos ?? head` and `pos || head`
    // disagree: `||` reads a valid position 0 as absent and falls back to the
    // selection head, silently moving an image dropped at the very start of the
    // document down to wherever the caret was. Every other stubbed position in this
    // file is truthy or null, where the two operators agree.
    stubReadThatNeverCompletes();
    const { view } = mount("abcd");
    stubDropPos(view, 0);
    view.dispatch({ selection: { anchor: 3 } });

    fireDropAt(view.contentDOM, { files: IMAGE_FILE });

    expect(view.state.field(pendingImageAnchors)).toEqual([
      { requestId: expect.any(String), anchor: 0 },
    ]);
    view.destroy();
  });

  it("swallows an image drop on a read-only doc without queueing an anchor", () => {
    // The read is driven to COMPLETION, unlike the neighbouring drop tests, and
    // that is what gives the `post` assertion teeth: with the `canWrite()` gate
    // deleted the file is submitted, this reader runs to onload and posts. Against
    // a never-completing read, `post` is unreachable and the assertion cannot fail.
    stubFileReader((reader) => {
      reader.result = "data:image/png;base64,AAAA";
      reader.onload?.();
    });
    const { view, post } = mount("ab", false);
    // Stubbed so that deleting the `canWrite()` gate makes this test FAIL rather
    // than pass for the wrong reason — see stubDropPos.
    stubDropPos(view, 1);

    fireDropAt(view.contentDOM, { files: IMAGE_FILE });

    // A read-only document must still not hand the file to the browser to open
    // (that is the drop handler's preventDefault, not observable here — see the
    // note above). What IS observable is that no write traffic leaves the webview.
    expect(view.state.field(pendingImageAnchors).length).toBe(0);
    expect(post).not.toHaveBeenCalled();
    view.destroy();
  });
});
