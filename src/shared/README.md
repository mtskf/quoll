# src/shared

Zero-dependency types and helpers consumed by **both** the extension host (`src/`)
and the webview (`src/webview/`).

## Invariants

- **No imports.** No `vscode`, no `react`, no DOM, no Node built-ins. Either-side
  imports break the other side's build.
- **Versioned envelope.** Every wire message carries `protocol: 1`. The version
  field exists before any compatibility break does — when `protocol: 2` is
  needed, peers can detect mismatch at the boundary.
- **docVersion authority.** The host owns `docVersion` (derived from VS Code's
  native `TextDocument.version`). Host→webview `Document` messages carry
  `docVersion: number`. Webview→host `Edit` messages carry `baseDocVersion: number`
  — the version the webview was editing on top of. The host accepts an edit iff
  `baseDocVersion === lastAppliedDocVersion` (exact equality); older or newer
  bases are rejected and the webview is resynced via the next `Document`
  snapshot.

## Why hand-rolled validators

`protocol.ts` is the single wire contract for two discriminated unions
(`HostToWebview` and `WebviewToHost`), and most of its bytes are the per-variant
JSDoc pinning each field's provenance and bounds — not validator boilerplate a
schema library would absorb. A dependency would also break the module's
no-imports rule, since both sides of the bridge consume it. The validators
reject malformed payloads at the boundary so both sides can trust the
discriminated union past that point.
