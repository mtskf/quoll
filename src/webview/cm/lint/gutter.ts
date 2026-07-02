// Opt-in advisory-lint gutter: one severity dot per line that has a finding.
//
// A READ-ONLY view of `lintField` (cm/lint/extension.ts) — it never mutates the
// document and is fully independent of the host write-gate. Held in a webview
// Compartment (editor.ts) so when the `quoll.lint.gutter.enabled` setting is
// off the whole gutter() extension is absent and `.cm-gutters` takes no width,
// leaving the centred reading column pixel-identical to the no-gutter default.
//
// markers(view) is re-run by CodeMirror on every view update and diffed via
// RangeSet.eq, so a setLintDiagnostics effect (no doc change) still refreshes
// the dots; GutterMarker.eq compares severity to avoid needless repaints.

import { type Extension, RangeSet, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import { lintField } from "./extension.js";
import type { LintDiagnostic, LintSeverity } from "./types.js";

// warning outranks info: a line with both shows a single warning dot.
function isHigher(candidate: LintSeverity, current: LintSeverity): boolean {
  return candidate === "warning" && current === "info";
}

/** Collapse diagnostics to one highest-severity mark per line. Keys are
 *  line-start offsets into `doc`; a diagnostic is attributed to the line of its
 *  `from` offset. Pure + exported so the grouping/precedence is unit-tested
 *  without a live EditorView. */
export function lintGutterLineMarks(
  doc: Text,
  diagnostics: readonly LintDiagnostic[]
): Map<number, LintSeverity> {
  const marks = new Map<number, LintSeverity>();
  for (const d of diagnostics) {
    const lineStart = doc.lineAt(d.from).from;
    const current = marks.get(lineStart);
    if (current === undefined || isHigher(d.severity, current)) {
      marks.set(lineStart, d.severity);
    }
  }
  return marks;
}

class LintGutterMarker extends GutterMarker {
  constructor(readonly severity: LintSeverity) {
    super();
  }

  override eq(other: LintGutterMarker): boolean {
    return other.severity === this.severity;
  }

  override toDOM(): Node {
    const dot = document.createElement("div");
    dot.className = `quoll-lint-gutter-dot quoll-lint-gutter-dot-${this.severity}`;
    return dot;
  }
}

const MARKER_BY_SEVERITY: Record<LintSeverity, LintGutterMarker> = {
  warning: new LintGutterMarker("warning"),
  info: new LintGutterMarker("info"),
};

// Exported so a happy-dom fallback test can assert the RangeSet directly when
// the gutter view-plugin's DOM rendering is flaky under the no-layout viewport
// (Task 3 note / Codex review finding 4).
export function buildGutterMarkers(view: EditorView): RangeSet<GutterMarker> {
  const diagnostics = view.state.field(lintField, false);
  if (!diagnostics || diagnostics.length === 0) {
    return RangeSet.empty;
  }
  const marks = lintGutterLineMarks(view.state.doc, diagnostics);
  // Sort by offset: RangeSet.of requires ascending ranges (Map iteration order
  // is insertion order, which follows diagnostic order — not guaranteed sorted).
  const positions = [...marks.keys()].sort((a, b) => a - b);
  return RangeSet.of(
    positions.map((pos) => MARKER_BY_SEVERITY[marks.get(pos) as LintSeverity].range(pos))
  );
}

// Dot styling. Colours resolve from the same --vscode-* tokens the lint
// underlines use (cm/lint/extension.ts), so the gutter follows the active theme
// with no JS bridge. Width is fixed and small to keep the opted-in gutter
// unobtrusive.
const quollLintGutterTheme = EditorView.theme({
  ".cm-gutter.quoll-lint-gutter": {
    width: "10px",
    paddingLeft: "2px",
  },
  ".quoll-lint-gutter-dot": {
    boxSizing: "border-box",
    width: "6px",
    height: "6px",
    marginTop: "0.55em", // nudge the dot onto the text baseline of var(--quoll-line-height)
    borderRadius: "50%",
  },
  ".quoll-lint-gutter-dot-warning": {
    backgroundColor: "var(--vscode-editorWarning-foreground, #bf8803)",
  },
  ".quoll-lint-gutter-dot-info": {
    backgroundColor: "var(--vscode-editorInfo-foreground, #3794ff)",
  },
});

/** The opt-in advisory-lint gutter extension. Drop into a Compartment so it can
 *  be toggled at runtime without rebuilding the editor state. */
export function quollLintGutter(): Extension {
  return [
    gutter({
      class: "quoll-lint-gutter",
      markers: buildGutterMarkers,
    }),
    quollLintGutterTheme,
  ];
}
