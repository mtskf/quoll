/**
 * Versioned typed message protocol between the extension host and the webview.
 *
 * Why a single Document variant (and not Revive / Update):
 *   The host is the canonical owner of the document. Every content push to the
 *   webview is the *same* operation — "here is the authoritative snapshot at
 *   docVersion N" — regardless of what triggered it (initial mount, panel
 *   revive, external editor change, or echo of a webview-accepted edit). The
 *   webview's reaction is identical in all four cases: replace editor state
 *   with content, apply theme, update write capability, drop if stale. The
 *   legacy `reason` discriminator is gone from the type — see
 *   `DocumentMessage` JSDoc below for the validator pass-through and emitter
 *   key-set pin.
 *
 * Why baseDocVersion (and not docVersion / nextDocVersion) on Edit:
 *   The host owns docVersion (it derives from VS Code's native
 *   TextDocument.version). The webview cannot mint version numbers — it can
 *   only declare "this is the version I was editing on top of." The host
 *   accepts the edit iff baseDocVersion === lastAppliedDocVersion; on accept
 *   it calls applyEdit, reads the resulting TextDocument.version as the new
 *   lastAppliedDocVersion, and pushes the next authoritative Document.
 *
 * Why a separate `protocol` envelope field:
 *   `protocol: 1` is the negotiation point for any future incompatible change.
 *   When `protocol: 2` is needed, peers can detect mismatch at the boundary
 *   before parsing the payload. Adding the field now costs nothing; adding it
 *   later requires coordinated rollout.
 *
 * Rules for this module:
 *   - No imports beyond TypeScript itself. No `vscode`, no `react`, no DOM.
 *     Both sides of the bridge consume it; either-side-only dependencies break
 *     the other side's build.
 *   - Validators are hand-rolled. A 4 KB module beats a 40 KB dependency for
 *     four discriminated unions.
 */

export const PROTOCOL_VERSION = 1;

/** Hard cap on inbound webview→host content payload length, measured in UTF-16
 *  code units (i.e. `String.prototype.length`). 4 * 1024 * 1024 code units is
 *  larger than any realistic Markdown note while small enough to bound
 *  webview→host abuse. Note: this is character count, not byte count — UTF-8
 *  wire size is 1–3× the code-unit count (BMP CJK 3 bytes / 1 code unit is
 *  the upper bound; non-BMP surrogate pairs land at 4 bytes / 2 code units
 *  = 2×). Symmetric with MAX_HREF_LENGTH below.
 *
 *  Directionality: this cap applies only to `EditMessage.content` (webview →
 *  host). It does NOT apply to `DocumentMessage.content` (host → webview)
 *  because the host is the canonical source of document content — its payload
 *  is `canonicalDocumentText(document)` (the host's `TextDocument.getText()`
 *  normalized to the document's `eol`) and is not a webview-controlled abuse
 *  vector. Capping host→webview content would
 *  silently fail the seed path for any Markdown file larger than the cap, so
 *  the boundary check on that side is `typeof content === "string"` only. */
export const MAX_CONTENT_LENGTH = 4 * 1024 * 1024;

/** Hard cap on inbound webview→host `open-external` href length, measured
 *  in UTF-16 code units (i.e. `String.prototype.length`). 8192 code units
 *  is larger than every URL the C0 / RFC 3986 fragments we accept can
 *  produce while small enough to bound webview→host abuse. Note: this is
 *  character count, not byte count — UTF-8 wire size is 1–3× the code-
 *  unit count (BMP CJK 3 bytes / 1 code unit is the upper bound; non-BMP
 *  surrogate pairs land at 4 bytes / 2 code units = 2×).
 *  Symmetric with MAX_CONTENT_LENGTH's directionality posture — applies
 *  only to webview→host. */
export const MAX_HREF_LENGTH = 8 * 1024;

/** Hard cap on a webview→host line number in a `context-handoff`. 1-based.
 *  0x7fffffff (max 32-bit signed) far exceeds any real Markdown file's line
 *  count while bounding a forged/abusive value. Lines are clamped again
 *  host-side to the live document's line count (the authoritative bound). */
export const MAX_LINE_NUMBER = 0x7fffffff;

/** Hard cap on the number of lint diagnostics in one inbound `lint-diagnostics`
 *  message. The webview computes advisory lint over the raw Markdown; a
 *  pathological document (e.g. hundreds of trailing-space lines) stays well
 *  under this, while the cap bounds a forged/abusive payload from a
 *  compromised webview. Symmetric with the other webview→host bounds. */
export const MAX_LINT_DIAGNOSTICS = 2000;

/** Hard cap on a single lint diagnostic's `message` length, in UTF-16 code
 *  units. First-party rule messages are short sentences; 1024 is generous
 *  headroom while bounding abuse. */
export const MAX_LINT_MESSAGE_LENGTH = 1024;

/** Hard cap on a single lint diagnostic's `code` (stable rule id) length. */
export const MAX_LINT_CODE_LENGTH = 128;

/** Upper cap on each 0-based line/character coordinate in a `lint-diagnostics`
 *  entry. 0x7fffffff (max 32-bit signed) far exceeds any real document's line
 *  count / line length while bounding a forged/abusive value — symmetric with
 *  `MAX_LINE_NUMBER` for `context-handoff`. Defense-in-depth at the protocol
 *  boundary: the conversion stays host-document-independent (no clamp against a
 *  live document), so the cap is the only bound on a coordinate. */
export const MAX_LINT_COORDINATE = 0x7fffffff;

/** Hard cap on a pasted/dropped image's DECODED byte length — the reject
 *  threshold. 10 MiB bounds abuse while covering screenshots/photos. Authoritative
 *  enforcement is host-side after base64 decode (src/extension/image-ingest.ts). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Transfer headroom above the reject threshold. A *slightly* oversized image
 *  must still REACH the host so it can answer with a precise "too-large" toast,
 *  rather than being silently dropped at the validator below. Grossly oversized
 *  images (whose base64 would exceed MAX_IMAGE_DATA_LENGTH) are dropped
 *  webview-side (console.warn) — a degenerate case, documented in the
 *  security-audit note. */
const IMAGE_TRANSFER_CEILING_BYTES = MAX_IMAGE_BYTES + 4 * 1024 * 1024;

/** Hard cap on the inbound `image-write` base64 payload length, in UTF-16 code
 *  units. base64 inflates bytes by 4/3; +3 absorbs the padding tail. Sized from
 *  IMAGE_TRANSFER_CEILING_BYTES (not MAX_IMAGE_BYTES) so the host reliably
 *  receives the 10–14 MiB band and emits the too-large toast. */
export const MAX_IMAGE_DATA_LENGTH = Math.ceil(IMAGE_TRANSFER_CEILING_BYTES / 3) * 4 + 3;

/** Hard cap on the inbound `image-write` requestId length. The webview mints a
 *  short monotonic counter string; 64 bounds a malformed/abusive value. */
export const MAX_REQUEST_ID_LENGTH = 64;

type Envelope = { protocol: typeof PROTOCOL_VERSION };

// ---------- Editor-preset settings (shared source of truth) ----------

/** The four preset-only editor-surface settings and their allowed ids. ONE
 *  source of truth for both directions: the host→webview `EditorConfigMessage`
 *  field validators and the webview→host `update-config` key+value validator
 *  read it, so a new id can never be accepted on one side and rejected on the
 *  other. Defaults are NOT positional here — see `EDITOR_PREF_DEFAULTS` for the
 *  default id of each key. Keys are the exact dotted config ids in
 *  package.json's contributes.configuration. */
export const EDITOR_PREF_ENUMS = {
  "quoll.editor.fontFamily": ["default", "serif", "sans"],
  "quoll.editor.fontSize": ["small", "default", "large", "x-large"],
  "quoll.editor.lineHeight": ["compact", "cozy", "roomy"],
  "quoll.editor.contentWidth": ["narrow", "medium", "wide"],
} as const satisfies Record<string, readonly string[]>;

/** Default id per key = today's rendering (Font/Size Default, Line-height Cozy,
 *  Content-width Medium). Single source consumed by host readers, the webview
 *  field, AND the package.json crosscheck test. */
export const EDITOR_PREF_DEFAULTS = {
  "quoll.editor.fontFamily": "default",
  "quoll.editor.fontSize": "default",
  "quoll.editor.lineHeight": "cozy",
  "quoll.editor.contentWidth": "medium",
} as const satisfies {
  [K in keyof typeof EDITOR_PREF_ENUMS]: (typeof EDITOR_PREF_ENUMS)[K][number];
};

export type EditorPrefKey = keyof typeof EDITOR_PREF_ENUMS;
export type FontFamilyPref = (typeof EDITOR_PREF_ENUMS)["quoll.editor.fontFamily"][number];
export type FontSizePref = (typeof EDITOR_PREF_ENUMS)["quoll.editor.fontSize"][number];
export type LineHeightPref = (typeof EDITOR_PREF_ENUMS)["quoll.editor.lineHeight"][number];
export type ContentWidthPref = (typeof EDITOR_PREF_ENUMS)["quoll.editor.contentWidth"][number];

const EDITOR_PREF_VALUE_SETS: Record<EditorPrefKey, ReadonlySet<string>> = {
  "quoll.editor.fontFamily": new Set(EDITOR_PREF_ENUMS["quoll.editor.fontFamily"]),
  "quoll.editor.fontSize": new Set(EDITOR_PREF_ENUMS["quoll.editor.fontSize"]),
  "quoll.editor.lineHeight": new Set(EDITOR_PREF_ENUMS["quoll.editor.lineHeight"]),
  "quoll.editor.contentWidth": new Set(EDITOR_PREF_ENUMS["quoll.editor.contentWidth"]),
};

/** True iff `key` is one of the 4 allowlisted keys AND `value` is a string in
 *  that key's id set. Object.hasOwn (NOT `key in`) so a prototype key
 *  ("toString"/"constructor") is rejected instead of indexing a Function and
 *  throwing. Shared by the editor-config field checks and the update-config
 *  value check so the host can never accept an id the webview enum does not know. */
export function isPrefValue(key: string, value: unknown): boolean {
  if (!Object.hasOwn(EDITOR_PREF_VALUE_SETS, key)) {
    return false;
  }
  return typeof value === "string" && EDITOR_PREF_VALUE_SETS[key as EditorPrefKey].has(value);
}

// ---------- Host → Webview ----------

/** The theme signal carried on `document` + `theme` messages. A 1:1 encoding of
 *  VS Code's `ColorThemeKind` (Light / Dark / HighContrast / HighContrastLight)
 *  — the host maps its enum onto these four values (see
 *  `src/extension/session/theme-kind.ts`) and carries the FULL kind with no
 *  information loss at the boundary. `HighContrast` is HC *Black* (a dark HC
 *  theme) → `"hc-dark"`; `HighContrastLight` → `"hc-light"`. The webview rounds
 *  BOTH `hc-*` values down to a single `.hc-theme` CSS class (display-only — the
 *  escape hatch neutralises the palette to host `--vscode-*` tokens, which
 *  already differ between the two HC kinds). Keeping `hc-dark`/`hc-light`
 *  distinct on the wire means a future per-HC-kind tune needs no protocol
 *  migration. Replaced the prior boolean dark/light flag, which could not
 *  distinguish HC from Light and forced HC onto the `.light-theme` palette. */
export const THEME_KINDS = ["dark", "light", "hc-dark", "hc-light"] as const;
export type ThemeKind = (typeof THEME_KINDS)[number];

const THEME_KIND_SET: ReadonlySet<string> = new Set(THEME_KINDS);

/** True iff `value` is one of the four allowlisted ThemeKind literals. Boundary
 *  guard for the `document` / `theme` validators (mirrors `isPrefValue`'s
 *  `new Set` posture). */
export function isThemeKind(value: unknown): value is ThemeKind {
  return typeof value === "string" && THEME_KIND_SET.has(value);
}

/** Authoritative document snapshot. The host posts a Document on every
 *  observed change — initial mount, panel revive, external edit, or echo
 *  of a webview-accepted edit. The webview's reaction is identical across
 *  origins: replace editor state with `content`, apply theme, update
 *  write capability, drop if `docVersion` is stale relative to its
 *  current displayed state.
 *
 *  Document carries no `reason` discriminator. The validator ignores
 *  unknown extra fields (forward-compat) and `buildDocumentMessage` is
 *  pinned by the key-set test in
 *  test/extension/document-message.test.ts to never emit `reason`.
 *  Host and webview always ship together in one `.vsix`, so the wire
 *  never holds mismatched peers and `PROTOCOL_VERSION` does not need to
 *  bump for this shape.
 *
 *  `content` is `canonicalDocumentText(document)` — `TextDocument.getText()`
 *  normalized to the document's `eol` (identical to `getText()` for the
 *  uniform documents VS Code produces) — and is intentionally not size-capped
 *  at the protocol layer — see MAX_CONTENT_LENGTH for the directionality
 *  rationale. */
export type DocumentMessage = Envelope & {
  type: "document";
  content: string;
  docVersion: number;
  themeKind: ThemeKind;
  canWrite: boolean;
};

/** Theme change only — no content, no version. Pushed on
 *  onDidChangeActiveColorTheme. */
export type ThemeMessage = Envelope & {
  type: "theme";
  themeKind: ThemeKind;
};

/** Host→webview editor-surface preference push. Independent of the document
 *  lifecycle (it carries no content / version), so it is delivered as its own
 *  message rather than folded into DocumentMessage: a settings change must not
 *  force a full document reseed. Pushed at seed time and on
 *  workspace.onDidChangeConfiguration. Carries every editor-surface setting —
 *  the opt-in advisory-lint gutter, the opt-in advisory prose lint, the native-
 *  spellcheck toggle, and the four typography presets — modelled to grow (add
 *  fields, keep the type) as more editor-surface settings appear. */
export type EditorConfigMessage = Envelope & {
  type: "editor-config";
  lintGutter: boolean;
  proseLint: boolean;
  spellcheck: boolean;
  fontFamily: FontFamilyPref;
  fontSize: FontSizePref;
  lineHeight: LineHeightPref;
  contentWidth: ContentWidthPref;
};

/** Host→webview one-shot caret apply. Posted exactly once on the panel's
 *  active edge (`onDidChangeViewState`, `.active` false→true) carrying the
 *  host's `lastKnownCaret` so the caret the user left in the text editor
 *  lands in Quoll. 0-based `{line, character}` (VS Code `Position`
 *  convention). A PURE SIDE CHANNEL — the webview applies it with a
 *  selection-only `view.dispatch` and NEVER posts an Edit in response (the
 *  apply→selectionSet→report round-trip is doc-neutral and suppressed by the
 *  `applyingRemoteCaret` flag). The webview re-clamps to its live document. */
export type CaretApplyMessage = Envelope & {
  type: "caret-apply";
  line: number;
  character: number;
};

/** Host→webview rejection of a webview-originated Edit. Sent in lieu of a
 *  reseed `DocumentMessage` when `validateMarkdownForWrite` refuses the
 *  inbound content (unsafe URL, malformed frontmatter, or an internal
 *  parser throw). Carrying the rejection as a distinct message keeps the
 *  webview's content intact: the existing `document` arm would overwrite
 *  the user's typed bytes with the disk snapshot, silently losing their
 *  edit. The webview routes this to the same reducer arm that handles
 *  webview-side postMessage failures (`serialize-error`) — both block save
 *  on the same gate and clear `editInFlight`. The reducer accepts any
 *  string `code` because the wire crosses a TypeScript boundary; the
 *  shell casts back to `MarkdownErrorCode` when dispatching. `detail` is
 *  intentionally omitted from the wire shape for now — the forward-compat
 *  "ignore unknown fields" envelope check means future extension does
 *  not require a protocol bump. */
export type EditRejectedMessage = Envelope & {
  type: "edit-rejected";
  error: {
    code: string;
    message: string;
  };
};

/** Host→webview result of an `image-write` request. `ok` is true only when the
 *  host validated, sniffed, and wrote the file; `relativePath` (present iff ok)
 *  is the document-relative markdown destination the webview inserts. On
 *  rejection the host surfaces a human-readable toast itself, so the failure arm
 *  carries no reason string — the webview only clears its pending entry. */
export type ImageWriteResultMessage = Envelope & {
  type: "image-write-result";
  requestId: string;
} & ({ ok: true; relativePath: string } | { ok: false; relativePath?: undefined });

/** Host→webview instruction to run an inline-formatting command on the
 *  active selection. Sent by the `quoll.format` command (bound to a
 *  keybinding scoped to the active Quoll editor) to the active panel's
 *  webview, which performs the actual CodeMirror transaction — no document
 *  mutation happens on the host side. `action` is an inline union (NOT
 *  imported from the webview) to keep this module import-free. */
export type FormatCommandMessage = Envelope & {
  type: "format-command";
  action: "bold" | "italic" | "code" | "strike" | "link";
};

const FORMAT_COMMAND_ACTIONS: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "code",
  "strike",
  "link",
]);

export function buildFormatCommandMessage(
  action: FormatCommandMessage["action"]
): FormatCommandMessage {
  return { protocol: PROTOCOL_VERSION, type: "format-command", action };
}

export type HostToWebview =
  | DocumentMessage
  | ThemeMessage
  | EditRejectedMessage
  | ImageWriteResultMessage
  | EditorConfigMessage
  | CaretApplyMessage
  | FormatCommandMessage;

// ---------- Webview → Host ----------

/** Webview→host signal that the webview has mounted (`src/webview/shell.ts`
 *  posts this immediately after the host-message subscription is wired).
 *  The host (`quoll-editor-panel.ts`, `case "ready":`) replies by posting
 *  the current authoritative `DocumentMessage` — there is no separate
 *  revive path, and the reply carries no `reason` field (see
 *  `DocumentMessage` JSDoc above). The `ready` arm is the reliable
 *  fallback when the eager seed misses the webview listener registration. */
export type ReadyMessage = Envelope & {
  type: "ready";
};

/** Local user edit. `baseDocVersion` is the host-issued docVersion the webview
 *  was editing on top of when it produced the change. The host accepts iff
 *  baseDocVersion === lastAppliedDocVersion (exact match): older bases are
 *  stale (a newer document has already been applied) and newer bases are
 *  impossible (the webview never mints version numbers — only the host does).
 *  Mismatches are rejected and the webview is resynced via the next Document
 *  snapshot.
 *
 *  `content` is bounded by MAX_CONTENT_LENGTH at the validator boundary —
 *  this is the directional cap that protects the host from oversized
 *  webview-originated payloads. */
export type EditMessage = Envelope & {
  type: "edit";
  content: string;
  baseDocVersion: number;
};

/** Webview→host request to open an external URL. The webview's click
 *  handler (link-handlers.ts) posts this after a local sanity check
 *  (decodeMarkdownDestination + isAllowedUrl); the host (QuollEditorPanel)
 *  RE-validates via isAllowedUrl before calling env.openExternal — defense
 *  in depth so a malicious or buggy webview cannot bypass the URL gate.
 *
 *  `href` is the already-decoded URL string (post
 *  decodeMarkdownDestination) — NOT raw Markdown source bytes. The host
 *  feeds it straight to isAllowedUrl + Uri.parse with no further decode. */
export type OpenExternalMessage = Envelope & {
  type: "open-external";
  href: string;
};

/** Webview→host request to open a relative in-workspace Markdown link
 *  (`[text](./other.md)`) with the Quoll editor — the phase-1 page-to-page
 *  navigation channel. The webview posts this (instead of `open-external`)
 *  when the decoded destination is allowlisted, SCHEMELESS, NON-ABSOLUTE, and
 *  its path ends in `.md`. The host owns `document.uri`, so the webview sends
 *  only the decoded relative destination STRING — never a path or Uri. The
 *  host (`handleOpenLink`) resolves it against the document's directory,
 *  RE-validates (isAllowedUrl + schemeless + non-absolute + `.md` +
 *  workspace/doc-dir containment), and routes through
 *  `vscode.openWith(target, "quoll.editMarkdown")`.
 *
 *  `href` is the already-decoded destination (post
 *  `decodeMarkdownDestination`) — NOT raw Markdown source bytes. Bounded by
 *  `MAX_HREF_LENGTH` at the validator, symmetric with `open-external`. */
export type OpenLinkMessage = Envelope & {
  type: "open-link";
  href: string;
};

/** Webview→host request to materialise a pasted/dropped image to disk. `data`
 *  is base64 (no `data:` prefix); the host re-sniffs the decoded bytes and NEVER
 *  trusts a client-supplied type. `requestId` correlates the async
 *  `image-write-result`. Both fields are length-bounded at the validator. */
export type ImageWriteMessage = Envelope & {
  type: "image-write";
  requestId: string;
  data: string;
};

/** Webview→host request to hand the current selection to Claude Code as an
 *  `@<file>#L<start>-<end>` reference. The host owns `document.uri`, so the
 *  webview sends only the selection geometry — never a path. `startLine` /
 *  `endLine` are 1-based and inclusive; when `hasSelection` is false they
 *  carry the caret's line (kept on the wire so the shape is uniform) and the
 *  host emits a whole-file `@<path>` reference, ignoring them. The host
 *  re-clamps both to the live document's line count before use. */
export type ContextHandoffMessage = Envelope & {
  type: "context-handoff";
  hasSelection: boolean;
  startLine: number;
  endLine: number;
};

/** Webview→host request to hand the current FILE to the Codex (openai.chatgpt)
 *  VS Code extension. Codex's only public document-taking command,
 *  `chatgpt.addFileToThread(uri)`, adds the WHOLE file (it exposes no public
 *  Uri+range command), so this message carries NO selection geometry — the host
 *  adds THIS document's uri whole. A DISTINCT type (not a `target` field on
 *  ContextHandoffMessage) follows the one-type-per-operation convention here,
 *  keeps the Claude context-handoff wire byte-identical, and fails closed on an
 *  unknown-type host. */
export type CodexContextHandoffMessage = Envelope & {
  type: "codex-context-handoff";
};

/** Webview→host request to reopen the current document in VS Code's built-in
 *  text editor — the top-right "Open in text editor" button and the Quoll→text
 *  half of the editor toggle. Envelope-only: the host owns `document.uri` and
 *  reopens its OWN document, so no path/geometry crosses the wire (like
 *  `codex-context-handoff`). A PURE SIDE CHANNEL — it never enters the
 *  host-session reducer or the write-lock and mutates no document. The host
 *  re-applies the caret it already tracks to the reopened text editor. */
export type SwitchToTextMessage = Envelope & {
  type: "switch-to-text";
};

/** Single construction point for the `switch-to-text` envelope, shared by the
 *  webview button + the CM chord command and pinned against `isWebviewToHost`
 *  by test/shared/protocol.test.ts. */
export function buildSwitchToTextMessage(): SwitchToTextMessage {
  return { protocol: PROTOCOL_VERSION, type: "switch-to-text" };
}

/** Webview→host request to persist an editor-surface preset. The host
 *  re-validates key+value (isPrefValue) then writes global config. A PURE SIDE
 *  CHANNEL — never enters the reducer/write-lock (like open-external). NEVER
 *  trust the webview key/value. The write fires onDidChangeConfiguration → the
 *  host re-pushes editor-config → every webview applies (host = single source of
 *  truth; the UI reflects the pushed state, not an optimistic local write). */
export type UpdateConfigMessage = Envelope & {
  type: "update-config";
  key: EditorPrefKey;
  value: string;
};

/** Webview→host one-shot caret report. Posted whenever the CodeMirror
 *  selection changes while Quoll is the active editor, so the host always
 *  holds the latest caret for the Quoll→text-editor handoff. 0-based
 *  `{line, character}` (VS Code `Position` convention — line 0 is the first
 *  line). A PURE SIDE CHANNEL: the host stores it in a per-panel
 *  `lastKnownCaret` and NEVER feeds it into the host-session reducer or the
 *  write-lock (like `context-handoff` / `lint-diagnostics`). Coordinates are
 *  bounded by `MAX_LINT_COORDINATE` at the boundary and re-clamped to the
 *  live document before the host applies them. No debounce — the message is
 *  tiny and the host only keeps the most recent value.
 *
 *  `selectedChars` is the character count (UTF-16 code units, matching the
 *  caret's character semantics) of the PRIMARY selection — `range.to -
 *  range.from`, 0 when the selection is collapsed. The host appends it to the
 *  status-bar caret readout (`… (N selected)`); it never positions anything, so
 *  the Quoll→text caret handoff ignores it. Bounded by `MAX_LINT_COORDINATE`
 *  at the boundary like the coordinates (any real selection is far smaller —
 *  it cannot exceed the open document's length, which itself has no wire-level
 *  cap: host→webview `DocumentMessage.content` is deliberately uncapped, and
 *  `MAX_CONTENT_LENGTH` bounds only webview→host edits/saves). */
export type CaretReportMessage = Envelope & {
  type: "caret-report";
  line: number;
  character: number;
  selectedChars: number;
};

/** One advisory lint finding on the wire, as a 0-based line/character range
 *  (VS Code `Position` convention) — NOT an absolute offset. The webview owns
 *  the only document parse (CodeMirror, LF-internal) and converts its offsets
 *  via `doc.lineAt()` before sending; the host builds a `vscode.Range` from
 *  these coordinates directly. Line/character is deliberate over offsets:
 *    - EOL-invariant: CodeMirror is LF-internal but the host `TextDocument` may
 *      be CRLF, so an absolute offset would diverge by one per preceding line.
 *      Line/character is identical under both.
 *    - Host-document-independent: the host reproduces the webview's intended
 *      range without re-deriving it from its (possibly transiently-stale) copy
 *      of the text, so a mid-edit set self-heals once the document converges.
 *  The reserved `fix` field of the webview's `LintDiagnostic` is intentionally
 *  NOT carried: autofix is applied locally in the webview (`Mod-.` via
 *  `cm/lint/apply-fix.ts`) and requires no host round-trip. `severity` is advisory only — "error"
 *  is structurally impossible here, mirroring the lint layer's policy that
 *  write-blocking failures belong to the host write-gate, not lint. */
export type LintDiagnosticWire = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  severity: "warning" | "info";
  code: string;
  message: string;
};

/** Webview→host mirror of the editor's current advisory lint set, for the
 *  Problems panel. A pure side channel: the host publishes it into a
 *  `DiagnosticCollection` and never feeds it into the host-session reducer (no
 *  write lock, no document mutation) — like `image-write` / `context-handoff`.
 *  Sent on every debounced recompute AND on initial mount; an empty array is
 *  the explicit "no findings / cleared" signal. The webview is the single
 *  source of truth — the host does NOT re-lint. */
export type LintDiagnosticsMessage = Envelope & {
  type: "lint-diagnostics";
  diagnostics: readonly LintDiagnosticWire[];
};

export type WebviewToHost =
  | ReadyMessage
  | EditMessage
  | OpenExternalMessage
  | OpenLinkMessage
  | ImageWriteMessage
  | ContextHandoffMessage
  | CodexContextHandoffMessage
  | SwitchToTextMessage
  | UpdateConfigMessage
  | LintDiagnosticsMessage
  | CaretReportMessage;

// ---------- Validators (boundary checks) ----------

function isEnvelopeWithType(value: unknown): value is { protocol: unknown; type: unknown } {
  return typeof value === "object" && value !== null && "protocol" in value && "type" in value;
}

function isProtocolMatch(value: { protocol: unknown }): boolean {
  return value.protocol === PROTOCOL_VERSION;
}

function isValidDocVersion(value: unknown): value is number {
  // Safe integer + non-negative. Reject fractional versions (which would
  // make equality checks surprising) and values beyond 2^53 (which would
  // stop advancing correctly under TextDocument.version increments).
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidLineNumber(value: unknown): value is number {
  // 1-based, positive, safe integer, capped. Mirrors isValidDocVersion's
  // posture but with a 1 floor (line 0 does not exist) and an explicit cap.
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_LINE_NUMBER
  );
}

function isCaretCoordinate(value: unknown): value is number {
  // 0-based, non-negative, safe integer, capped — VS Code Position semantics.
  // Reuses MAX_LINT_COORDINATE: both are 0-based line/character caps. The host
  // and webview re-clamp to the live document; this is the boundary bound only.
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_LINT_COORDINATE
  );
}

function isSelectionCharCount(value: unknown): value is number {
  // A primary-selection character count: 0-based (0 = collapsed), non-negative,
  // safe integer, capped. Numerically identical to isCaretCoordinate but named
  // for its distinct meaning (a length, not a coordinate). Reuses
  // MAX_LINT_COORDINATE — any real selection is bounded by the document itself.
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_LINT_COORDINATE
  );
}

function isUnboundedContent(value: unknown): value is string {
  // Host→webview: trust the host to send whatever VS Code's TextDocument
  // contains. Capping here would silently drop the seed for oversized files.
  return typeof value === "string";
}

function isBoundedContent(value: unknown): value is string {
  // Webview→host: cap to bound oversized payloads from a user-controlled
  // surface. The exact boundary is asserted in test/shared/protocol.test.ts.
  return typeof value === "string" && value.length <= MAX_CONTENT_LENGTH;
}

export function isHostToWebview(value: unknown): value is HostToWebview {
  if (!isEnvelopeWithType(value) || !isProtocolMatch(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "document":
      return (
        isUnboundedContent(v.content) &&
        isValidDocVersion(v.docVersion) &&
        isThemeKind(v.themeKind) &&
        typeof v.canWrite === "boolean"
      );
    case "theme":
      return isThemeKind(v.themeKind);
    case "edit-rejected": {
      const err = v.error;
      return (
        typeof err === "object" &&
        err !== null &&
        typeof (err as Record<string, unknown>).code === "string" &&
        typeof (err as Record<string, unknown>).message === "string"
      );
    }
    case "image-write-result":
      // Discriminate on `ok`: a success MUST carry a string path; a failure
      // MUST NOT carry one. Distrust the peer even though the host builder is
      // already discriminated — an incoherent `{ok:true}` (no path) or
      // `{ok:false, relativePath:…}` is rejected at the boundary.
      if (typeof v.requestId !== "string" || typeof v.ok !== "boolean") {
        return false;
      }
      return v.ok ? typeof v.relativePath === "string" : v.relativePath === undefined;
    case "editor-config":
      return (
        typeof v.lintGutter === "boolean" &&
        typeof v.proseLint === "boolean" &&
        typeof v.spellcheck === "boolean" &&
        isPrefValue("quoll.editor.fontFamily", v.fontFamily) &&
        isPrefValue("quoll.editor.fontSize", v.fontSize) &&
        isPrefValue("quoll.editor.lineHeight", v.lineHeight) &&
        isPrefValue("quoll.editor.contentWidth", v.contentWidth)
      );
    case "caret-apply":
      return isCaretCoordinate(v.line) && isCaretCoordinate(v.character);
    case "format-command":
      return typeof v.action === "string" && FORMAT_COMMAND_ACTIONS.has(v.action);
    default:
      return false;
  }
}

function isLintDiagnosticWire(value: unknown): value is LintDiagnosticWire {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const d = value as Record<string, unknown>;
  const isCoord = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_LINT_COORDINATE;
  if (
    !isCoord(d.startLine) ||
    !isCoord(d.startCharacter) ||
    !isCoord(d.endLine) ||
    !isCoord(d.endCharacter)
  ) {
    return false;
  }
  // Reject an inverted range (start strictly after end). vscode.Range would
  // silently normalise it, but rejecting at the boundary keeps a forged/buggy
  // webview from injecting nonsense diagnostics. Defense-in-depth — the
  // first-party engine never produces one.
  if (
    (d.startLine as number) > (d.endLine as number) ||
    ((d.startLine as number) === (d.endLine as number) &&
      (d.startCharacter as number) > (d.endCharacter as number))
  ) {
    return false;
  }
  return (
    (d.severity === "warning" || d.severity === "info") &&
    typeof d.code === "string" &&
    d.code.length <= MAX_LINT_CODE_LENGTH &&
    typeof d.message === "string" &&
    d.message.length <= MAX_LINT_MESSAGE_LENGTH
  );
}

export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (!isEnvelopeWithType(value) || !isProtocolMatch(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "ready":
      return true;
    case "edit":
      return isBoundedContent(v.content) && isValidDocVersion(v.baseDocVersion);
    case "open-external":
      return typeof v.href === "string" && v.href.length <= MAX_HREF_LENGTH;
    case "open-link":
      // Same shape + bound as open-external: an already-decoded destination
      // string capped at MAX_HREF_LENGTH. The host re-derives everything else
      // (scheme, extension, containment) from this string — it is not trusted.
      return typeof v.href === "string" && v.href.length <= MAX_HREF_LENGTH;
    case "image-write":
      return (
        typeof v.requestId === "string" &&
        v.requestId.length <= MAX_REQUEST_ID_LENGTH &&
        typeof v.data === "string" &&
        v.data.length <= MAX_IMAGE_DATA_LENGTH
      );
    case "context-handoff":
      return (
        typeof v.hasSelection === "boolean" &&
        isValidLineNumber(v.startLine) &&
        isValidLineNumber(v.endLine)
      );
    case "codex-context-handoff":
      return true;
    case "lint-diagnostics":
      return (
        Array.isArray(v.diagnostics) &&
        v.diagnostics.length <= MAX_LINT_DIAGNOSTICS &&
        // Array.from materialises sparse-array holes as undefined so .every actually rejects them — bare .every skips holes.
        Array.from(v.diagnostics).every(isLintDiagnosticWire)
      );
    case "caret-report":
      return (
        isCaretCoordinate(v.line) &&
        isCaretCoordinate(v.character) &&
        isSelectionCharCount(v.selectedChars)
      );
    case "switch-to-text":
      return true;
    case "update-config":
      return typeof v.key === "string" && isPrefValue(v.key, v.value);
    default:
      return false;
  }
}
