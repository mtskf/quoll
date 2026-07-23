// Click-to-open for code references inside inline code. Resolves the click pos
// → walks up to InlineCode (deferring if a Link ancestor owns the click) →
// parseInlineCodeReference → posts an UNTRUSTED open-code-reference. The host
// re-validates everything.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { PROTOCOL_VERSION, type WebviewToHost } from "../../../shared/protocol.js";
import { type PostMessageHost, safePostMessage } from "../../safe-post-message.js";
import { intersectsAnySelection } from "../decorations/shared.js";
import { hasLinkAncestor, inlineCodeInterior } from "./inline-code-ref.js";
import { parseInlineCodeReference } from "./parse-code-reference.js";

export type CodeRefHost = PostMessageHost;

export function tryOpenCodeRefAt(state: EditorState, pos: number, host: CodeRefHost): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0);
  while (node !== null && node.name !== "InlineCode") {
    node = node.parent;
  }
  if (node === null || hasLinkAncestor(node)) {
    return false;
  }
  if (intersectsAnySelection(state.selection, node.from, node.to)) {
    return false;
  }
  const interior = inlineCodeInterior(node);
  if (interior === null) {
    return false;
  }
  const ref = parseInlineCodeReference(state.sliceDoc(interior.from, interior.to));
  if (ref === null) {
    return false;
  }
  const message: WebviewToHost = {
    protocol: PROTOCOL_VERSION,
    type: "open-code-reference",
    path: ref.path,
    ...(ref.line !== undefined ? { line: ref.line } : {}),
    ...(ref.col !== undefined ? { col: ref.col } : {}),
  };
  return safePostMessage(host, message, "code-ref-open");
}

export function handleCodeRefMouseDown(
  event: MouseEvent,
  view: EditorView,
  host: CodeRefHost
): boolean {
  if (event.button !== 0) {
    return false;
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (pos === null || pos < 0 || pos > view.state.doc.length) {
    return false;
  }
  if (tryOpenCodeRefAt(view.state, pos, host)) {
    event.preventDefault();
    return true;
  }
  return false;
}

export function quollCodeRefClickHandler(host: CodeRefHost): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      return handleCodeRefMouseDown(event, view, host);
    },
  });
}
