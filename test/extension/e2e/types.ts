// Local mirror of the host-side types the E2E suite reads. Kept here
// (rather than `import type`-ing src/) so the test tsconfig's rootDir
// of `.` does not need to widen to cover src/.
//
// These shapes MUST stay aligned with:
//   - src/extension/test-harness.ts   (TestHarness, RecordedEvent, PanelControls)
//   - src/shared/protocol.ts          (DocumentMessage)
// A mismatch surfaces as a tsc error in test/extension/types-equality.test.ts
// (wired via test/extension/tsconfig.unit.json), which is the desired
// loud-failure mode. The message-shape interfaces below are
// structurally pinned by AssertEqual<...> assertions; RecordedEventShape /
// PanelControlsShape / TestHarnessShape are intentionally looser.
//
// Wire shapes mirror src/shared/protocol.ts's `Envelope & { ... }`
// intersection-alias form exactly. The message-shape mirrors below
// are `type X = EnvelopeShape & { ... }` (not `interface X { ... }`)
// because TypeScript's `AssertEqual<A, B>` identity check distinguishes
// an intersection alias from an interface even when the structural shape
// is identical — pinning the same construction style on both sides keeps
// the drift guard exact. The shapes also intentionally do NOT carry
// `readonly` modifiers, matching the canonical wire types.
//
// The `PROTOCOL_VERSION` value is imported from the e2e suite's own
// constants mirror; a vitest guard (test/shared/protocol-version.test.ts)
// keeps that mirror in sync with the canonical export.

import type { TextDocument, Uri, WebviewPanel, WorkspaceEdit } from "vscode";
import type { PROTOCOL_VERSION } from "./constants";

type EnvelopeShape = { protocol: typeof PROTOCOL_VERSION };

export type DocumentMessageShape = EnvelopeShape & {
  type: "document";
  content: string;
  docVersion: number;
  isDarkTheme: boolean;
  canWrite: boolean;
};

export type ReadyMessageShape = EnvelopeShape & {
  type: "ready";
};

export type EditMessageShape = EnvelopeShape & {
  type: "edit";
  content: string;
  baseDocVersion: number;
};

export type OpenExternalMessageShape = EnvelopeShape & {
  type: "open-external";
  href: string;
};

export type ThemeMessageShape = EnvelopeShape & {
  type: "theme";
  isDarkTheme: boolean;
};

export type EditRejectedMessageShape = EnvelopeShape & {
  type: "edit-rejected";
  error: {
    code: string;
    message: string;
  };
};

export type EditorConfigMessageShape = EnvelopeShape & {
  type: "editor-config";
  lintGutter: boolean;
  spellcheck: boolean;
};

export type CaretReportMessageShape = EnvelopeShape & {
  type: "caret-report";
  line: number;
  character: number;
};

export type SwitchToTextMessageShape = EnvelopeShape & {
  type: "switch-to-text";
};

export type CaretApplyMessageShape = EnvelopeShape & {
  type: "caret-apply";
  line: number;
  character: number;
};

export type ImageWriteResultMessageShape = EnvelopeShape & {
  type: "image-write-result";
  requestId: string;
} & ({ ok: true; relativePath: string } | { ok: false; relativePath?: undefined });

export type ImageWriteMessageShape = EnvelopeShape & {
  type: "image-write";
  requestId: string;
  data: string;
};

export type ContextHandoffMessageShape = EnvelopeShape & {
  type: "context-handoff";
  hasSelection: boolean;
  startLine: number;
  endLine: number;
};

export type CodexContextHandoffMessageShape = EnvelopeShape & {
  type: "codex-context-handoff";
};

export type LintDiagnosticWireShape = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  severity: "warning" | "info";
  code: string;
  message: string;
};

export type LintDiagnosticsMessageShape = EnvelopeShape & {
  type: "lint-diagnostics";
  diagnostics: readonly LintDiagnosticWireShape[];
};

// The host→webview union mirror. Previously omitted because the E2E
// suite only asserted on outbound message shapes by type-narrowing in
// the predicates (isDocumentEvent etc.); now that `edit-rejected` joins
// the union, pin the full union too so a future variant (e.g.
// `bulk-replace`) does not silently drift past the guard.
export type HostToWebviewShape =
  | DocumentMessageShape
  | ThemeMessageShape
  | EditRejectedMessageShape
  | ImageWriteResultMessageShape
  | EditorConfigMessageShape
  | CaretApplyMessageShape;

export type WebviewToHostShape =
  | ReadyMessageShape
  | EditMessageShape
  | OpenExternalMessageShape
  | ImageWriteMessageShape
  | ContextHandoffMessageShape
  | CodexContextHandoffMessageShape
  | LintDiagnosticsMessageShape
  | CaretReportMessageShape
  | SwitchToTextMessageShape;

export interface RecordedEventShape {
  readonly message: { type: string } & Record<string, unknown>;
  readonly timestamp: number;
}

export interface RecordedInboundShape {
  readonly raw: unknown;
  readonly timestamp: number;
}

export interface PanelControlsShape {
  readonly document: TextDocument;
  readonly webviewPanel: WebviewPanel;
  simulateInbound(message: WebviewToHostShape): void;
  rawSimulate(raw: unknown): void;
}

export interface TestHarnessShape {
  readonly events: readonly RecordedEventShape[];
  readonly inboundEvents: readonly RecordedInboundShape[];
  readonly activePanel: PanelControlsShape | null;
  applyEditOverride: ((edit: WorkspaceEdit) => Thenable<boolean>) | null;
  webviewPostMessageOverride:
    | ((message: { type: string } & Record<string, unknown>) => Thenable<boolean>)
    | null;
  openExternalOverride: ((url: string) => Thenable<boolean>) | null;
  buildWebviewHtmlOverride: (() => string) | null;
  writeImageFileOverride: ((uri: Uri, content: Uint8Array) => Thenable<void>) | null;
  diskConflictPromptOverride:
    | ((message: string, ...actions: string[]) => Thenable<string | undefined>)
    | null;
  // Read-only: the host writes `lastError` (via recordError); tests only
  // observe it. Mirrors the getter-only surface on the real TestHarness so
  // a test that tries `harness.lastError = null` (which would corrupt the
  // error-waiter machinery) fails at tsc, not silently at runtime.
  readonly lastError: string | null;
  waitForEvent<T extends RecordedEventShape = RecordedEventShape>(
    predicate: ((e: RecordedEventShape) => e is T) | ((e: RecordedEventShape) => boolean),
    timeoutMs?: number
  ): Promise<T>;
  waitForInbound(
    predicate: (e: RecordedInboundShape) => boolean,
    timeoutMs?: number
  ): Promise<RecordedInboundShape>;
  waitForError(predicate: (msg: string) => boolean, timeoutMs?: number): Promise<string>;
  reset(): void;
  clearEvents(): void;
}
