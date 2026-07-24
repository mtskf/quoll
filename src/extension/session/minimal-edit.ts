// The pure host-apply span helper now lives in the session-independent
// `document-write/` write-executor layer (Plan S6 — the write pipeline lives in
// one place). This module stays as a re-export so existing session-side
// importers and the pinned `minimal-edit.test.ts` property tests keep their
// path unchanged.
export type { MinimalEditSpan } from "../document-write/minimal-edit.js";
export { minimalEditSpan } from "../document-write/minimal-edit.js";
