// src/webview/cm/reading-stats/compute.ts
// Pure, DOM-free text statistics over raw Markdown. Frontmatter and fenced
// code are stripped so prose counts are not inflated by config/code; CJK is
// counted character-based (each code point = one "word"), matching how CJK
// text has no whitespace word boundaries. Kept pure (string -> object) so the
// counting contract is unit-testable without a CodeMirror view. Heading/link
// counts live in structure.ts (they need the Lezer parse), not here.

export interface ReadingTextStats {
  /** CJK code points (1 each) + whitespace-delimited Latin tokens. */
  words: number;
  /** Non-whitespace Unicode code points in the counted text. */
  characters: number;
  /** ceil(words / WORDS_PER_MINUTE), min 1 when any words, else 0. */
  readingTimeMinutes: number;
}

/** Average adult prose reading speed (words per minute). A documented estimate;
 *  CJK code points each count as one word, so CJK time is a rough over-estimate
 *  by design (KISS over per-script tuning). */
export const WORDS_PER_MINUTE = 200;

/** Leading YAML frontmatter: a `---` fence on the FIRST line through its next
 *  `---` line. Anchored at string start so a mid-document thematic break `---`
 *  is never mistaken for frontmatter. */
const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Opener of a fenced code block: >=3 of one fence char (` or ~), plus any info
 *  string on the rest of the line. */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
/** A CLOSER candidate: a whole line of >=3 fence chars and nothing else (bar
 *  surrounding spaces). Same-char + length>=opener is enforced at the call site. */
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** Remove fenced code blocks by scanning lines. A regex backreference cannot
 *  express the CommonMark rule "the closing fence is the SAME character and AT
 *  LEAST as long as the opener": an exact-length backreference misses a longer
 *  closer, while an any-length `{3,}` closer lets a shorter inner fence close a
 *  longer block early (both surfaced in review). The scanner records the
 *  opener's char + length and closes only on a same-char fence of length >=
 *  opener. An unclosed opener is left as prose (kept), matching prior behaviour. */
function stripFencedCode(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (open === null) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const fenceChar = open[1][0];
    const fenceLen = open[1].length;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const close = FENCE_CLOSE.exec(lines[j]);
      if (close !== null && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        break;
      }
    }
    if (j < lines.length) {
      i = j + 1; // matched closer → drop opener..closer inclusive
    } else {
      out.push(lines[i]); // unclosed opener: keep as prose, resume after it
      i += 1;
    }
  }
  return out.join("\n");
}

/** CJK code points counted individually (no whitespace word boundaries).
 *  Explicit `\u` escapes (never literal glyphs) so a homoglyph can't silently
 *  shift a range boundary, and the `u` flag makes the ranges operate on code
 *  points — an astral char (emoji, CJK Ext-B) is then one unit, never a
 *  double-counted surrogate pair straddling U+D800–U+DFFF. Ranges:
 *  Hiragana/Katakana (U+3040–U+30FF), CJK Ext-A (U+3400–U+4DBF), CJK Unified
 *  (U+4E00–U+9FFF), Hangul syllables (U+AC00–U+D7AF), CJK Compatibility
 *  Ideographs (U+F900–U+FAFF). */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/gu;

export function computeReadingStats(text: string): ReadingTextStats {
  const stripped = stripFencedCode(text.replace(FRONTMATTER, ""));

  const cjkWords = stripped.match(CJK)?.length ?? 0;
  const latin = stripped.replace(CJK, " ").trim();
  const latinWords = latin.length === 0 ? 0 : latin.split(/\s+/).length;
  const words = cjkWords + latinWords;

  const characters = [...stripped.replace(/\s/g, "")].length;

  const readingTimeMinutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));

  return { words, characters, readingTimeMinutes };
}
