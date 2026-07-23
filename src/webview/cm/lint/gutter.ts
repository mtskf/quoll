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

  // Decorative by architecture — carries NO role/aria and is not the AT path
  // (A11Y-04). CodeMirror sets `aria-hidden="true"` on the enclosing `.cm-gutters`
  // container (@codemirror/view GutterView), so any `role`/`aria-label` on this dot
  // sits inside an aria-hidden subtree and is unreachable by assistive tech — an
  // ancestor's aria-hidden cannot be un-hidden by a descendant. This mirrors the
  // fold gutter's mouse-affordance-by-design stance. The authoritative AT path for
  // every lint finding is the host-side Problems-panel mirror (quoll.lint.problems
  // .enabled, ON by default): a native vscode.DiagnosticCollection that is fully
  // keyboard-navigable and screen-reader-announced and carries severity + message +
  // rule code + range (extension/lint/lint-diagnostics.ts). Severity here is
  // conveyed to sighted users by the dot colour alone, which is acceptable only
  // because this is a redundant, opt-in (default-off) visual cue over that
  // AT surface — not a sole channel. (Two honest bounds on the mirror — it is
  // user-disableable and wire-capped — are documented at MARK_BY_SEVERITY in
  // cm/lint/extension.ts; they do not affect the default path.)
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
