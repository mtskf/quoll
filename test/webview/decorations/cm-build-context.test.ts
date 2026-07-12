// @vitest-environment happy-dom
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { toCtx } from "../../../src/webview/cm/decorations/build-context.js";

describe("toCtx", () => {
  it("snapshots state, selection, visibleRanges and the syntax tree from a view", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "# hi" }) });
    const ctx = toCtx(view);
    expect(ctx.state).toBe(view.state);
    expect(ctx.selection).toBe(view.state.selection);
    expect(ctx.visibleRanges).toBe(view.visibleRanges);
    expect(ctx.tree).toBe(syntaxTree(view.state));
    view.destroy();
  });
});
