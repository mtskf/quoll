// Single guard asserting an EditorView is mounted inside its `.quoll-editor`
// host wrapper. Copied verbatim (bar the error prefix) in floating-toolbar-
// scroll / outline-panel / switch-editor; this is the one definition. The
// caller passes its own name so the thrown message still points at the failing
// extension.

import type { EditorView } from "@codemirror/view";

/** Return the `.quoll-editor` host element enclosing `view`, or throw a
 *  `contextName`-prefixed error if the view is not mounted inside one. */
export function requireQuollEditorHost(view: EditorView, contextName: string): HTMLElement {
  const host = view.dom.closest(".quoll-editor");
  if (!(host instanceof HTMLElement)) {
    throw new Error(`${contextName}: EditorView must be mounted inside a .quoll-editor host`);
  }
  return host;
}
