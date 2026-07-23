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
import { parseInlineCodeReference } from "./parse-code-reference.js";

export type CodeRefHost = PostMessageHost;

function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) {
      return true;
    }
  }
  return false;
}

function hasLinkAncestor(node: SyntaxNode): boolean {
  let p: SyntaxNode | null = node.parent;
  while (p !== null) {
    if (p.name === "Link") {
      return true;
    }
    p = p.parent;
  }
  return false;
}

export function tryOpenCodeRefAt(state: EditorState, pos: number, host: CodeRefHost): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0);
  while (node !== null && node.name !== "InlineCode") {
    node = node.parent;
  }
  if (node === null || hasLinkAncestor(node)) {
    return false;
  }
  if (selectionIntersects(state, node.from, node.to)) {
    return false;
  }
  const cur = node.cursor();
  let firstMarkTo: number | null = null;
  let lastMarkFrom: number | null = null;
  if (cur.firstChild()) {
    do {
      if (cur.name === "CodeMark") {
        if (firstMarkTo === null) {
          firstMarkTo = cur.to;
        }
        lastMarkFrom = cur.from;
      }
    } while (cur.nextSibling());
  }
  if (firstMarkTo === null || lastMarkFrom === null || firstMarkTo >= lastMarkFrom) {
    return false;
  }
  const ref = parseInlineCodeReference(state.sliceDoc(firstMarkTo, lastMarkFrom));
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
