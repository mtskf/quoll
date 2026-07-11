import {
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type LintDiagnosticWire, MAX_LINT_DIAGNOSTICS } from "../../../shared/protocol.js";
import { createIncrementalLinter, lintMarkdown } from "./engine.js";
import type { LintDiagnostic, LintSeverity } from "./types.js";

// Fail-open wrapper: lint is advisory, so a parser/rule throw must degrade to
// "no diagnostics" + a logged error rather than break the editor transaction.
// (The host write-gate has the same defense; here a throw merely drops a squiggle.)
// Generic over the linter fn so both the one-shot full parse (`lintMarkdown`)
// and the per-view incremental linter share one guard.
function safeLint(
  lint: (raw: string) => readonly LintDiagnostic[],
  text: string
): readonly LintDiagnostic[] {
  try {
    return lint(text);
  } catch (err) {
    console.error("[quoll] lint threw; surfacing no diagnostics", err);
    return [];
  }
}

// Gates the opt-in advisory PROSE rules (passive-voice / filler-words /
// long-sentence). Held in a Compartment in editor.ts and reconfigured by the
// host's editor-config push (setProseLint), mirroring the lint-gutter compartment
// shape. A Facet — not a StateField — so it is always readable with a fail-safe
// default (no source ⇒ `false`, e.g. in tests that mount quollLint() without the
// compartment) and has no create-order dependency. Read by lintField.create and
// the debounced compute plugin, both of which pass it to the engine as
// `{ prose }`. Last-writer-wins over the single source the compartment provides.
export const proseLintEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? false,
});

// Publishes a freshly-computed diagnostic set. Dispatched by the debounced
// compute plugin; carries NO document change, so applying it never mutates bytes.
export const setLintDiagnostics = StateEffect.define<readonly LintDiagnostic[]>();

// Holds the current diagnostics. Cheap on every transaction: it applies a fresh
// result when one is published, else MAPS the held diagnostics through the
// change — it never re-lints synchronously on docChanged (that would put a full
// re-parse on the keystroke critical path). The initial value is computed once
// at field creation so a document present at creation lints immediately.
export const lintField = StateField.define<readonly LintDiagnostic[]>({
  create(state) {
    const prose = state.facet(proseLintEnabled);
    return safeLint((raw) => lintMarkdown(raw, { prose }), state.doc.toString());
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLintDiagnostics)) {
        return effect.value;
      }
    }
    // No fresh result yet (still inside the debounce window). Map the held
    // diagnostics through the change so their ranges stay positionally valid:
    // no out-of-bounds `to`, no misplaced underline, and a range the edit
    // collapses is dropped. Matches @codemirror/lint's between-runs mapping, and
    // avoids both the stale-offset glitch and a clear->repaint flicker. The `fix`
    // descriptor is deliberately NOT mapped here: the apply command re-lints the
    // live doc instead of reading this display cache, so a stale cached fix is
    // never applied (see cm/lint/apply-fix.ts).
    if (tr.docChanged && value.length > 0) {
      const mapped: LintDiagnostic[] = [];
      for (const d of value) {
        if (d.wholeLine) {
          // Re-anchor the whole-line diagnostic to its line-start position. assoc -1
          // keeps it before any insertion AT the line start, so typing at the start
          // of the blank line does not push the anchor mid-line. A deletion that
          // merges the blank line into its neighbour can leave the mapped offset off
          // a line start; keep the diagnostic only while its anchor is still a line
          // start (so the gutter dot / hover stay attributed to the right line),
          // otherwise drop it and let the next fresh compute (<= 250ms) republish the
          // corrected set. This avoids the per-keystroke flicker — the diagnostic is
          // mapped, not dropped — while keeping the line anchor honest.
          const from = tr.changes.mapPos(d.from, -1);
          if (tr.newDoc.lineAt(from).from === from) {
            mapped.push({ ...d, from, to: from });
          }
          continue;
        }
        const from = tr.changes.mapPos(d.from, 1);
        const to = tr.changes.mapPos(d.to, -1);
        if (from < to) {
          mapped.push({ ...d, from, to });
        }
      }
      return mapped;
    }
    return value;
  },
});

// The rendered underline DecorationSet, held as a MAPPED RangeSet rather than
// rebuilt from lintField on every keystroke. On a fresh lint publish the set is
// built once from the new diagnostics; between publishes (inside the debounce
// window) each doc change MAPS the existing set through tr.changes (O(changes)),
// matching @codemirror/lint's own shape and avoiding an O(D) range-creation +
// Decoration.set(sorted) rebuild per keystroke. lintField still owns the raw
// diagnostics array (hover / gutter / Problems wire read it); this field is
// display-only and is derived solely from that same published array on each fresh
// publish, so the inline marks in the two structures never diverge (both drop a
// range the edit collapses under the same from-side/to-side mapping).
const lintDecorationsField = StateField.define<DecorationSet>({
  create(state) {
    const diagnostics = state.field(lintField, false);
    return diagnostics ? buildLintDecorations(diagnostics) : Decoration.none;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLintDiagnostics)) {
        return buildLintDecorations(effect.value);
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const LINT_DEBOUNCE_MS = 250;

// Recompute off the keystroke critical path: on every doc change, (re)arm a
// trailing-edge debounce; when it fires, lint the latest document text and
// publish via setLintDiagnostics. Mirrors the codebase's existing
// debounce/bounded-recompute pattern (edit-sync, image-field) so lint never
// stalls typing on a large document. Display-only: the dispatch carries an
// effect, never a change.
const lintComputePlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | undefined;
    // One incremental linter per view: it caches the previous parse tree and
    // reuses it via TreeFragment, so a typing pause re-parses only the changed
    // region instead of the whole document. Not primed at construction — the
    // view mounts with doc:"" and the real content arrives via the applyDocument
    // reseed, whose own docChanged schedules the first (unavoidable) full parse
    // that warms prevTree. Every subsequent typing pause reuses it.
    private readonly lint = createIncrementalLinter();

    update(update: ViewUpdate): void {
      // Recompute on a doc change OR a prose-gate toggle. The toggle reconfigures
      // the prose compartment (a transaction with no doc change), so compare the
      // facet across the transaction; when it flips, re-lint so the prose
      // underlines appear/clear within one debounce window (≤ LINT_DEBOUNCE_MS).
      const proseToggled =
        update.startState.facet(proseLintEnabled) !== update.state.facet(proseLintEnabled);
      if (update.docChanged || proseToggled) {
        this.schedule(update.view);
      }
    }

    private schedule(view: EditorView): void {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => {
        this.timer = undefined;
        // Read the facet at FIRE time (post-transaction state), so the newest
        // toggle value is used even if it landed after this was scheduled.
        const prose = view.state.facet(proseLintEnabled);
        view.dispatch({
          effects: setLintDiagnostics.of(
            safeLint((raw) => this.lint(raw, { prose }), view.state.doc.toString())
          ),
        });
      }, LINT_DEBOUNCE_MS);
    }

    destroy(): void {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
      }
    }
  }
);

const MARK_BY_SEVERITY: Record<LintSeverity, Decoration> = {
  warning: Decoration.mark({ class: "quoll-lint-mark-warning" }),
  info: Decoration.mark({ class: "quoll-lint-mark-info" }),
};

// Map diagnostics -> in-editor decorations. ONLY a non-empty inline range becomes a
// severity-classed underline mark. A `wholeLine` diagnostic (currently the blank-line
// no-multiple-blanks info finding) is given NO in-editor decoration: a filled
// full-line `Decoration.line` with an inset left-bar is visually indistinguishable
// from a blockquote's left rule (block-style.ts), so painting blank section-spacers
// that way read as a phantom blockquote even though there is no `>` in the source.
// Whole-line findings surface instead via the Problems mirror, the opt-in gutter dot,
// and the hover tooltip — none of which read this decoration set. `Decoration.set`'s
// `true` sorts the marks, so the caller need not pre-sort. Exported for unit tests.
export function buildLintDecorations(diagnostics: readonly LintDiagnostic[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const d of diagnostics) {
    if (!d.wholeLine && d.to > d.from) {
      ranges.push(MARK_BY_SEVERITY[d.severity].range(d.from, d.to));
    }
  }
  return Decoration.set(ranges, true);
}

// Diagnostics covering a position. Marks use CodeMirror's half-open [from, to)
// convention; a `wholeLine` diagnostic (a blank line) is hit anywhere on its line
// via the INCLUSIVE [from, to] range its rule emits (to === from for a truly empty
// line, the whitespace run's end for a whitespace-only line), so a hover over the
// blank line's whitespace still surfaces the tooltip. Pure + exported so the hover
// hit-test is unit-testable.
export function diagnosticsAt(
  diagnostics: readonly LintDiagnostic[],
  pos: number
): LintDiagnostic[] {
  return diagnostics.filter((d) =>
    d.wholeLine ? pos >= d.from && pos <= d.to : pos >= d.from && pos < d.to
  );
}

// Project the editor's LF-internal offset diagnostics to the wire's 0-based
// line/character form. `doc` is the CodeMirror document the offsets index into
// (LF-internal; see editor.ts applyDocument). `doc.lineAt(offset)` yields the
// 1-based line + its start offset, from which the 0-based VS Code line and the
// in-line character fall out. Explicit field-by-field projection so the
// reserved `fix` field of LintDiagnostic never crosses the wire.
//
// Capped at MAX_LINT_DIAGNOSTICS: the host's `lint-diagnostics` boundary
// validator REJECTS the whole message when `diagnostics.length` exceeds the cap,
// which would blank the Problems mirror entirely. Since prose findings (esp.
// filler-words) can be far denser than the sparse structural rules, a long
// document could realistically cross 2000; truncating here keeps the mirror
// populated with the first N (diagnostics arrive sorted by document position) —
// a partial mirror beats a rejected/blank one. The in-editor underlines are
// UNAFFECTED (they read the uncapped lintField), so nothing is hidden in the
// editor; only the host-side Problems mirror is bounded to what the wire accepts.
export function toWireDiagnostics(
  doc: Text,
  diagnostics: readonly LintDiagnostic[]
): LintDiagnosticWire[] {
  return diagnostics.slice(0, MAX_LINT_DIAGNOSTICS).map((d) => {
    const start = doc.lineAt(d.from);
    const end = doc.lineAt(d.to);
    return {
      startLine: start.number - 1,
      startCharacter: d.from - start.from,
      endLine: end.number - 1,
      endCharacter: d.to - end.from,
      severity: d.severity,
      code: d.code,
      message: d.message,
    };
  });
}

// Mirror the editor's current advisory lint set out of CodeMirror to a sink
// (the host bridge in editor.ts posts it as a `lint-diagnostics` message → the
// Problems panel). Fires on every `setLintDiagnostics` effect (the debounced
// fresh compute) — NOT on the intermediate doc-change re-maps, so the host is
// updated at the lint cadence (≤ one post per debounce window), never per
// keystroke. The `setLintDiagnostics` transaction carries no doc change, so
// `view.state.doc` at update() time is the exact document the offsets index into.
// No mount-time constructor fire: in production the editor always mounts with an
// empty doc and real content arrives via a host reseed (a docChange that schedules
// the debounced compute → a `setLintDiagnostics` effect → the publisher posts),
// so a constructor fire would only ever post a redundant empty set during
// half-initialized mount (before the shell subscribes to host messages).
function lintDiagnosticsPublisher(
  sink: (diagnostics: readonly LintDiagnosticWire[]) => void
): Extension {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate): void {
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(setLintDiagnostics)) {
              sink(toWireDiagnostics(update.state.doc, effect.value));
            }
          }
        }
      }
    }
  );
}

// Hover a marked range -> a tooltip listing every diagnostic covering the position.
const lintHoverTooltip = hoverTooltip((view, pos) => {
  const diagnostics = view.state.field(lintField, false);
  if (!diagnostics) {
    return null;
  }
  const hits = diagnosticsAt(diagnostics, pos);
  if (hits.length === 0) {
    return null;
  }
  let from = hits[0].from;
  let to = hits[0].to;
  for (const h of hits) {
    if (h.from < from) {
      from = h.from;
    }
    if (h.to > to) {
      to = h.to;
    }
  }
  return {
    pos: from,
    end: to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "quoll-lint-tooltip";
      for (const h of hits) {
        const row = document.createElement("div");
        row.className = "quoll-lint-tooltip-row";
        row.textContent = `${h.message} (${h.code})`;
        dom.appendChild(row);
      }
      return { dom };
    },
  };
});

// Severity-coloured wavy underlines + a VS Code-styled hover tooltip. Colours
// resolve from the same --vscode-* tokens the rest of the editor uses, so the
// lint surface follows the active theme with no JS bridge. Lint is the only
// hover tooltip in the editor, so styling .cm-tooltip-hover directly is safe.
const quollLintTheme = EditorView.theme({
  ".quoll-lint-mark-warning": {
    textDecoration: "underline wavy var(--vscode-editorWarning-foreground, #bf8803)",
    textDecorationSkipInk: "none",
  },
  ".quoll-lint-mark-info": {
    textDecoration: "underline wavy var(--vscode-editorInfo-foreground, #3794ff)",
    textDecorationSkipInk: "none",
  },
  ".cm-tooltip-hover": {
    backgroundColor: "var(--vscode-editorHoverWidget-background, var(--vscode-editor-background))",
    color: "var(--vscode-editorHoverWidget-foreground, var(--vscode-editor-foreground))",
    border:
      "1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, transparent))",
    borderRadius: "3px",
  },
  ".quoll-lint-tooltip": {
    padding: "4px 8px",
    maxWidth: "32em",
    fontSize: "0.9em",
    fontFamily: "var(--vscode-font-family)",
    whiteSpace: "normal",
  },
  ".quoll-lint-tooltip-row + .quoll-lint-tooltip-row": {
    marginTop: "2px",
  },
});

// The advisory Markdown lint layer: recompute findings on change (debounced),
// underline them, and show the message on hover. Display-only (byte-identical
// round-trip) and fully independent of the host write-gate (validate-for-write.ts)
// — it never imports it and never blocks a write.
// Optional `sink`: when provided, a ViewPlugin publishes the current diagnostic
// set (as wire objects) on every debounced fresh compute, so the host can mirror
// them into VS Code's Problems panel. Omitting `sink` is
// backward-compatible — existing callers and tests that pass no argument are
// unaffected.
export function quollLint(sink?: (diagnostics: readonly LintDiagnosticWire[]) => void): Extension {
  const base = [
    lintField,
    lintDecorationsField,
    lintComputePlugin,
    lintHoverTooltip,
    quollLintTheme,
  ];
  return sink ? [...base, lintDiagnosticsPublisher(sink)] : base;
}
