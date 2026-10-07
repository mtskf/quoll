# src/shared

Zero-dependency types and helpers consumed by **both** the extension host (`src/`)
and the webview (`src/webview/`).

## Invariants

- **No imports.** No `vscode`, no `react`, no DOM, no Node built-ins. Either-side
  imports break the other side's build.
- **Versioned envelope.** Every wire message carries `protocol: PROTOCOL_VERSION`
  (currently 3 — version 2 made `DocumentMessage.eol` required, version 3 the
  Edit id pair `EditMessage.editId` / `DocumentMessage.settledEditId`). Peers
  detect a mismatch at the boundary before parsing the payload.
- **docVersion authority.** The host owns `docVersion` (derived from VS Code's
  native `TextDocument.version`). Host→webview `Document` messages carry
  `docVersion: number`. Webview→host `Edit` messages carry `baseDocVersion: number`
  — the version the webview was editing on top of. The host accepts an edit iff
  `baseDocVersion === lastAppliedDocVersion` (exact equality); older or newer
  bases are rejected and the webview is resynced via the next `Document`
  snapshot.
- **Edit id.** Every `Edit` carries a webview-minted, strictly increasing
  `editId`; every `Document` carries `settledEditId`, the highest `editId` the
  host has received (0 before the first). The webview reads it to tell whether
  a Document was produced before or after the host judged its in-flight Edit.

## Why hand-rolled validators

`protocol.ts` is the single wire contract for two discriminated unions
(`HostToWebview` and `WebviewToHost`), and most of its bytes are the per-variant
JSDoc pinning each field's provenance and bounds — not validator boilerplate a
schema library would absorb. A dependency would also break the module's
no-imports rule, since both sides of the bridge consume it. The validators
reject malformed payloads at the boundary so both sides can trust the
discriminated union past that point.
