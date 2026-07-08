// The host-snapshot reseed annotation. It lives in this neutral module (not in
// any feature) because it is consumed cross-cutting: editor.ts marks reseed
// transactions with it, and frontmatter, image-paste, fenced-code-collapse, and
// callout-marker-conceal all key on it to tell a host reseed apart from user
// edits.
//
// Why a dedicated annotation (not addToHistory=false): `addToHistory: false` is
// a generic history flag, not specific to host reseeds. Only applyDocument
// (editor.ts) is a host snapshot reseed, so it marks its transaction with
// `hostDocumentReseed`; the consumers key on THAT, never on addToHistory.

import { Annotation } from "@codemirror/state";

/** Marks a host-snapshot reseed transaction (set by editor.ts applyDocument).
 *  Consumers key on it to distinguish a reseed from user edits and from other
 *  addToHistory=false transactions. */
export const hostDocumentReseed = Annotation.define<boolean>();
