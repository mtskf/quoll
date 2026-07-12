import { describe, expect, it } from "vitest";
import {
  QUOLL_LINT_DIAGNOSTIC_SOURCE,
  toLintDiagnostics,
} from "../../../src/extension/lint/lint-diagnostics.js";
import type { LintDiagnosticWire } from "../../../src/shared/protocol.js";
import { Position } from "../vscode-stub.js";

describe("toLintDiagnostics", () => {
  it("maps line/character to a Range and warning severity, stamping source + code", () => {
    const wire: LintDiagnosticWire[] = [
      {
        startLine: 2,
        startCharacter: 0,
        endLine: 2,
        endCharacter: 8,
        severity: "warning",
        code: "heading-increment",
        message: "msg",
      },
    ];
    const [d] = toLintDiagnostics(wire);
    expect(d.range.start).toEqual(new Position(2, 0));
    expect(d.range.end).toEqual(new Position(2, 8));
    expect(d.severity).toBe(1); // DiagnosticSeverity.Warning
    expect(d.source).toBe(QUOLL_LINT_DIAGNOSTIC_SOURCE);
    expect(d.code).toBe("heading-increment");
    expect(d.message).toBe("msg");
  });

  it("maps info severity to Information (never Error)", () => {
    const [d] = toLintDiagnostics([
      {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 1,
        severity: "info",
        code: "x",
        message: "m",
      },
    ]);
    expect(d.severity).toBe(2); // DiagnosticSeverity.Information
  });

  it("returns an empty array for empty input", () => {
    expect(toLintDiagnostics([])).toEqual([]);
  });
});
