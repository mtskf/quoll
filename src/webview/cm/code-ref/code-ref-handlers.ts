// Open-a-code-reference for references inside inline code. Two triggers share
// one sink: a `mousedown` handler (resolves the click pos) and a `Mod-Enter`
// keymap command (resolves the caret pos). Both walk up to InlineCode (deferring
// if a Link ancestor owns it) → parseInlineCodeReference → post an UNTRUSTED
// open-code-reference. The host re-validates everything.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { PROTOCOL_VERSION, type WebviewToHost } from "../../../shared/protocol.js";
import { type PostMessageHost, safePostMessage } from "../../safe-post-message.js";
import { intersectsAnySelection } from "../decorations/shared.js";
import { hasLinkAncestor, inlineCodeInterior } from "./inline-code-ref.js";
import { parseInlineCodeReference } from "./parse-code-reference.js";

export type CodeRefHost = PostMessageHost;

/** Options for {@link tryOpenCodeRefAt}. `deferWhenSelectionIntersects` gates
 *  the mouse path: a click on an actively-selected/edited reference defers so
 *  the user can edit it (the reveal decoration is suppressed there too, so there
 *  is no clickable affordance). The keyboard command sets it FALSE — the caret
 *  sitting inside a reference is exactly how a keyboard user targets it, so the
 *  self-intersecting caret must NOT block the open. */
export type TryOpenCodeRefOptions = { deferWhenSelectionIntersects: boolean };

export function tryOpenCodeRefAt(
  state: EditorState,
  pos: number,
  host: CodeRefHost,
  opts: TryOpenCodeRefOptions = { deferWhenSelectionIntersects: true }
): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0);
  while (node !== null && node.name !== "InlineCode") {
    node = node.parent;
  }
  if (node === null || hasLinkAncestor(node)) {
    return false;
  }
  if (
    opts.deferWhenSelectionIntersects &&
    intersectsAnySelection(state.selection, node.from, node.to)
  ) {
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

/** The "open code reference" chord. Single source of truth — used by the keymap
 *  and pinned by a unit test. Mod = Cmd (mac) / Ctrl (win+linux). Mirrors the
 *  common "open link / go to file" gesture and matches the mouse path's sink.
 *  Returns false (passes through to CM's default Mod-Enter, e.g. insertBlankLine)
 *  when the caret is not inside a code reference, so it never steals the chord on
 *  ordinary lines. */
export const CODE_REF_OPEN_KEY = "Mod-Enter";

/** Command form of the code-reference open, driven by the caret (main selection
 *  head) rather than a pointer. Exported so the keymap test can invoke it on a
 *  real EditorView. Passes `deferWhenSelectionIntersects: false` — a keyboard
 *  user necessarily has the caret INSIDE the reference, which self-intersects the
 *  span, so the mouse path's editing-defer guard must not apply here. */
export function openCodeRefAtCaretCommand(host: CodeRefHost): Command {
  return (view) =>
    tryOpenCodeRefAt(view.state, view.state.selection.main.head, host, {
      deferWhenSelectionIntersects: false,
    });
}

/** Prec.high keymap binding CODE_REF_OPEN_KEY to the caret-open command. Prec.high
 *  so it is tried before defaultKeymap's Mod-Enter; the command returns false off
 *  a reference, so the default still runs there. */
export function quollCodeRefKeymap(host: CodeRefHost): Extension {
  return Prec.high(keymap.of([{ key: CODE_REF_OPEN_KEY, run: openCodeRefAtCaretCommand(host) }]));
}
