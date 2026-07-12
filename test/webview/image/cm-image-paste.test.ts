// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
import {
  addPendingAnchor,
  createImagePasteDrop,
  pendingImageAnchors,
} from "../../../src/webview/cm/image/image-paste.js";

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
