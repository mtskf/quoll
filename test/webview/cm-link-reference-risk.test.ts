import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { linkReferenceRisk } from "../../src/webview/cm/link-reference-risk.js";

describe("linkReferenceRisk", () => {
  it("scans a long nonblank run without per-line random access", () => {
    const state = EditorState.create({ doc: Array(2000).fill("ordinary text").join("\n") });
    const lineSpy = vi.spyOn(state.doc, "line");

    expect(linkReferenceRisk(state, state.doc.length)).toBe(false);
    expect(lineSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("finds a reference start above the current line", () => {
    const state = EditorState.create({ doc: "[a]:\ncontinuation\nmore text\nlast line" });
    expect(linkReferenceRisk(state, state.doc.length)).toBe(true);
  });

  it("stops at a blank line", () => {
    const state = EditorState.create({ doc: "[a]:\ncontinuation\n\nmore text\nlast line" });
    expect(linkReferenceRisk(state, state.doc.length)).toBe(false);
  });
});
