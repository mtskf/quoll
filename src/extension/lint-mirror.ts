// Owns the advisory-lint → Problems mirror and gates it behind the
// `quoll.lint.problems.enabled` setting. The webview always posts lint (the
// in-editor underlines are unconditional); this decides whether each post
// reaches the Problems panel. Pure of config reads — the enabled flag is
// injected so the panel stays the single place that touches `workspace`.

import type { Diagnostic, Uri } from "vscode";

/** Minimal write surface of a vscode.DiagnosticCollection that LintMirror
 *  drives. Injected as an interface so the gate is unit-testable without a
 *  live host (the real DiagnosticCollection satisfies it structurally). */
export interface LintDiagnosticSink {
  set(uri: Uri, diagnostics: readonly Diagnostic[]): void;
  delete(uri: Uri): void;
  clear(): void;
}

export class LintMirror {
  // Latest mirrored set per document (key = uri.toString()). Kept even while
  // disabled so re-enabling re-populates Problems immediately from the
  // last-known set — without waiting for the next webview re-lint (which only
  // fires on the next edit).
  private readonly cache = new Map<string, { uri: Uri; diagnostics: readonly Diagnostic[] }>();

  constructor(
    private readonly sink: LintDiagnosticSink,
    private enabled: boolean
  ) {}

  /** Record + (when enabled) publish the latest lint set for a document. */
  mirror(uri: Uri, diagnostics: readonly Diagnostic[]): void {
    this.cache.set(uri.toString(), { uri, diagnostics });
    if (this.enabled) {
      this.sink.set(uri, diagnostics);
    }
  }

  /** Drop a document on editor close: clear its Problems entry + cached set. */
  remove(uri: Uri): void {
    this.cache.delete(uri.toString());
    this.sink.delete(uri);
  }

  /** React to a `quoll.lint.problems.enabled` change. Disabling clears every
   *  mirrored entry; enabling re-publishes every cached set (so the active —
   *  and any other open — document re-populates without an edit). */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    if (enabled) {
      for (const { uri, diagnostics } of this.cache.values()) {
        this.sink.set(uri, diagnostics);
      }
    } else {
      this.sink.clear();
    }
  }
}
