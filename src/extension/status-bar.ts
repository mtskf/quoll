// Host-owned status-bar parity for an active Quoll editor. A custom editor is
// not a `TextEditor`, so `window.activeTextEditor` is undefined and VS Code
// drops ALL of its built-in status-bar items (cursor position, EOL, language,
// encoding, indentation). This reintroduces the subset whose data already
// flows to the host: cursor position (`Ln X, Col Y`), EOL (`LF`/`CRLF`), and a
// static language indicator.
//
// OUT of scope on purpose: encoding (no public VS Code API reads a document's
// encoding — the built-in indicator is internal) and indentation (no
// `TextEditor.options` for a custom editor). A non-empty PRIMARY selection is
// appended to the caret slot (`Ln X, Col Y (N selected)`, VS Code's native
// format) from the `selectedChars` count on the `caret-report` wire.
//
// Pure of VS Code: the formatters take primitives and the controller drives an
// injected `StatusBarSlot` interface, so the whole module unit-tests without a
// live host (the real `vscode.StatusBarItem` satisfies `StatusBarSlot`
// structurally). The panel is the single place that calls
// `window.createStatusBarItem` and feeds the live document in.

import type { Caret } from "./handoff/caret-handoff.js";

// vscode.EndOfLine: LF = 1, CRLF = 2. Mirrored as a literal union so this
// module stays vscode-free (no `import "vscode"`); the panel passes
// `document.eol` straight through, and the two-valued enum is the only input
// the formatter ever sees.
export type EndOfLineValue = 1 | 2;

const EOL_CRLF: EndOfLineValue = 2;

/** `Ln X, Col Y` — VS Code's built-in label. The caret is 0-based (VS Code
 *  `Position` convention); the status bar shows it 1-based. A non-empty
 *  primary selection appends ` (N selected)`, matching VS Code's native
 *  format; `selectedChars <= 0` (collapsed) renders position-only. */
export function formatCaretPosition(caret: Caret, selectedChars = 0): string {
  const position = `Ln ${caret.line + 1}, Col ${caret.character + 1}`;
  return selectedChars > 0 ? `${position} (${selectedChars} selected)` : position;
}

/** `LF` / `CRLF` from a `vscode.EndOfLine` value (1 = LF, 2 = CRLF). The input
 *  is the `1 | 2` union only; the runtime `else` (→ LF) is defensive, not a
 *  third case — the type keeps callers from ever passing anything else. */
export function formatEol(eol: EndOfLineValue): string {
  return eol === EOL_CRLF ? "CRLF" : "LF";
}

/** The caret to seed the status bar with when a panel opens: the caret
 *  stashed from a text→Quoll toggle wins, else the last webview-reported
 *  caret, else the document origin. Extracted so the seed decision is
 *  unit-tested rather than inlined at the panel construction site. */
export function resolveSeedCaret({
  switchCaret,
  lastKnownCaret,
}: {
  switchCaret: Caret | null;
  lastKnownCaret: Caret | null;
}): Caret {
  return switchCaret ?? lastKnownCaret ?? { line: 0, character: 0 };
}

/** A friendly language label from a `document.languageId`. Quoll only opens
 *  Markdown, so this is a lightweight capitalisation of the id (`markdown` →
 *  `Markdown`), NOT the full VS Code language-mode registry name. */
export function formatLanguageLabel(languageId: string): string {
  if (languageId.length === 0) {
    return languageId;
  }
  return languageId.charAt(0).toUpperCase() + languageId.slice(1);
}

// --- Word / character count + reading-time -------------------------------
//
// The count slot mirrors a Ulysses / Zettlr-style readout: prose words, raw
// character count, and a whole-minute reading-time estimate. The counting RULE
// lives here (the single source of truth) and is deliberately simple so it is
// predictable and fully unit-testable without a Markdown parse:
//
//   - Words + reading-time count PROSE only: YAML frontmatter and fenced code
//     blocks are stripped first so neither inflates the estimate (a code block
//     is not something you "read" at prose speed, and frontmatter is metadata).
//   - Character count is the raw document length (UTF-16 code units, matching
//     VS Code's native selection readout) — NOT prose-filtered. It reports
//     document size, so it stays provenance-free and predictable.
//   - Reading-time = words ÷ a fixed WPM constant, rounded up to whole minutes.

/** Words-per-minute constant for the reading-time estimate. 200 wpm is the
 *  conventional average adult silent-reading speed used by prose-focused
 *  editors; kept as a single named constant so the rule is greppable. */
const READING_WPM = 200;

/** Strip leading YAML frontmatter + fenced code blocks so neither inflates the
 *  prose word count / reading-time. Rule (line-based, no Markdown parse):
 *   - Frontmatter: only when the FIRST line is exactly `---`; stripped through
 *     the next `---` or `...` fence line. An unterminated opener is left intact
 *     (over-count beats swallowing the whole document).
 *   - Fenced code: a ``` or ~~~ opener (any indent / info string) through the
 *     matching closing fence of the same marker char; an unterminated fence
 *     runs to end-of-document. Fence lines themselves are dropped too. */
function stripNonProse(text: string): string {
  const lines = text.split("\n");
  let start = 0;

  // Leading YAML frontmatter (allow a trailing \r from CRLF documents).
  if (lines.length > 0 && /^---\s*\r?$/.test(lines[0])) {
    for (let i = 1; i < lines.length; i++) {
      if (/^(---|\.\.\.)\s*\r?$/.test(lines[i])) {
        start = i + 1;
        break;
      }
    }
  }

  const out: string[] = [];
  let fenceChar = "";
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (fenceChar === "") {
      const opener = /^\s*(```+|~~~+)/.exec(line);
      if (opener) {
        fenceChar = opener[1][0];
        continue;
      }
      out.push(line);
      continue;
    }
    // Inside a fence: a bare same-marker fence line (no info string) closes it.
    const closer = /^\s*(```+|~~~+)\s*\r?$/.exec(line);
    if (closer && closer[1][0] === fenceChar) {
      fenceChar = "";
    }
  }
  return out.join("\n");
}

/** Prose word count: whitespace-delimited tokens of the frontmatter/code-
 *  stripped text that contain at least one Unicode letter or number. The
 *  alphanumeric test keeps bare Markdown punctuation (`#`, `-`, `>`, `|`) from
 *  counting as words. Known limitation: scripts without inter-word spaces (e.g.
 *  CJK) count a run as one word — accepted for a v1 status-bar estimate. */
export function countWords(text: string): number {
  let count = 0;
  for (const token of stripNonProse(text).split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) {
      count++;
    }
  }
  return count;
}

/** Raw character count — the document's total length (UTF-16 code units,
 *  matching VS Code's native readout). NOT frontmatter/code-filtered. */
export function countCharacters(text: string): number {
  return text.length;
}

/** Whole-minute reading-time estimate: prose words ÷ READING_WPM, rounded up.
 *  0 words → 0 min (no special-casing); 1–200 words → 1 min. */
export function estimateReadingMinutes(words: number): number {
  return Math.ceil(words / READING_WPM);
}

/** Group an integer with `,` thousands separators (locale-independent so the
 *  formatter stays test-stable — `toLocaleString` varies by host locale). */
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The count slot's label: `<words> words · <chars> chars · <min> min read`,
 *  numbers grouped with thousands separators, singular nouns for a count of 1
 *  (`min read` stays fixed). Pure function of the document text — the single
 *  place the counting rule is rendered. */
export function formatDocumentStats(text: string): string {
  const words = countWords(text);
  const chars = countCharacters(text);
  const minutes = estimateReadingMinutes(words);
  const wordLabel = words === 1 ? "word" : "words";
  const charLabel = chars === 1 ? "char" : "chars";
  return `${groupThousands(words)} ${wordLabel} · ${groupThousands(chars)} ${charLabel} · ${minutes} min read`;
}

/** Minimal surface of a `vscode.StatusBarItem` the controller drives. Injected
 *  as an interface so the show/hide/update/dispose logic is unit-testable
 *  without a live host. */
export interface StatusBarSlot {
  text: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** The slots the controller owns, in native left-to-right order (caret is
 *  leftmost / highest priority; `count` is appended rightmost so the
 *  established caret→eol→language order is undisturbed). */
export interface StatusBarSlots {
  caret: StatusBarSlot;
  eol: StatusBarSlot;
  language: StatusBarSlot;
  count: StatusBarSlot;
}

/** Live inputs for a refresh: the 0-based caret, the document's EOL, and the
 *  primary-selection character count (0 = no selection). Required (mirroring
 *  the required `CaretReportMessage.selectedChars`) so a caller cannot silently
 *  conflate "no selection" with "count omitted" — the seed passes an explicit
 *  0 for its pre-any-caret-report state. */
export interface StatusBarView {
  caret: Caret;
  eol: EndOfLineValue;
  selectedChars: number;
}

export interface StatusBarController {
  /** Refresh the caret + EOL text from the live document. */
  update(view: StatusBarView): void;
  /** Refresh the word / character count + reading-time from the live document
   *  text. Kept separate from `update` so a selection change (which drives
   *  `update`) does not re-scan the whole document — only a content change does. */
  updateCount(text: string): void;
  /** Show all slots (call on the panel's active edge). */
  show(): void;
  /** Hide all slots (call on the inactive edge). */
  hide(): void;
  /** Dispose all slots (call when the panel is disposed). */
  dispose(): void;
}

/** Wire the injected slots into a controller. The language slot is static
 *  (set once); caret + EOL + count are seeded from `init` so a `show()` before
 *  the first `update()` / `updateCount()` never reveals a blank item. */
export function createStatusBarController(
  slots: StatusBarSlots,
  init: { view: StatusBarView; languageLabel: string; documentText: string }
): StatusBarController {
  slots.language.text = init.languageLabel;
  const all: readonly StatusBarSlot[] = [slots.caret, slots.eol, slots.language, slots.count];

  const controller: StatusBarController = {
    update({ caret, eol, selectedChars }) {
      slots.caret.text = formatCaretPosition(caret, selectedChars);
      slots.eol.text = formatEol(eol);
    },
    updateCount(text) {
      slots.count.text = formatDocumentStats(text);
    },
    show() {
      for (const slot of all) {
        slot.show();
      }
    },
    hide() {
      for (const slot of all) {
        slot.hide();
      }
    },
    dispose() {
      for (const slot of all) {
        slot.dispose();
      }
    },
  };

  controller.update(init.view);
  controller.updateCount(init.documentText);
  return controller;
}
