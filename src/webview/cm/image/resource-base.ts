// Webview-resource base URI for the open document, exposed as a CodeMirror
// facet so imageBlockField can resolve a relative image path against the
// document's location. Static per editor (set once at mount from the host's
// data-resource-base-uri attribute); never reconfigured at runtime. Empty
// string ("") means "no base" (non-file document) → relative images are left
// unresolved (rendered inert by the field's render-gate).

import { Facet } from "@codemirror/state";

export const quollResourceBaseUri = Facet.define<string, string>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : ""),
});
