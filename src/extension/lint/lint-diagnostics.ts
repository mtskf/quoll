// Convert the webview's advisory lint set (wire shape) into vscode.Diagnostic[]
// for the Problems panel. Pure and host-document-independent: the wire already
// carries 0-based line/character ranges (the webview converted its LF-internal
// CodeMirror offsets via doc.lineAt()), so this builds a vscode.Range directly
// — no positionAt, no dependency on the host's copy of the text. That is what
// makes it EOL-correct (CRLF documents) and stale-safe (a mid-edit set
// self-heals once the host document converges; line/character is re-rendered
// against whatever the document becomes). Severity is mapped Warning/Information
// ONLY. The webview is the single source of truth — this never re-lints.
// Write-gate failures are NOT lint and never reach here (they ride the
// edit-rejected/toast path).

import { Diagnostic, DiagnosticSeverity, Position, Range } from "vscode";

import type { LintDiagnosticWire } from "../../shared/protocol.js";

/** `vscode.Diagnostic.source` shown in the Problems panel for every mirrored
 *  lint finding. The per-diagnostic `code` carries the stable rule id. */
export const QUOLL_LINT_DIAGNOSTIC_SOURCE = "Quoll";

export function toLintDiagnostics(wire: readonly LintDiagnosticWire[]): Diagnostic[] {
  return wire.map((d) => {
    const range = new Range(
      new Position(d.startLine, d.startCharacter),
      new Position(d.endLine, d.endCharacter)
    );
    // Advisory severities only — "error" is structurally impossible on the wire,
    // so this two-way map is total. Never DiagnosticSeverity.Error.
    const severity =
      d.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information;
    const diagnostic = new Diagnostic(range, d.message, severity);
    diagnostic.source = QUOLL_LINT_DIAGNOSTIC_SOURCE;
    diagnostic.code = d.code;
    return diagnostic;
  });
}
