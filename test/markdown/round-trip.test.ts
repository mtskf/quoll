import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { detectLineSeparator, splitToCmText } from "../../src/webview/cm/seed.js";
import { loadFixtures } from "./load-fixtures.js";

// Round-trip parity gate (C9a).
//
// Under the CodeMirror text-canonical surface the raw Markdown IS the
// document — there is no Markdown parse→serialize step that can mutate the
// user's bytes. The gate is therefore TEXT-IDENTITY for UNIFORM-EOL sources
// (all-LF or all-CRLF): every fixture body must read back from the canonical
// CM doc byte-for-byte.
//
// SCOPE LIMITATION: the ONE byte transform the CM text layer still applies is
// whole-doc line-ending normalization — a mixed-EOL source (LF alongside CRLF)
// or a lone-CR source collapses to the single detected separator (e.g.
// "a\r\nb\nc" → "a\r\nb\r\nc", "a\rb" → "a\nb"). That is a documented design
// choice, NOT a Markdown-semantic mutation. The normalization is now owned at
// the host boundary by `canonicalDocumentText` (pinned by
// test/extension/document-canonical.test.ts + the `mixed-eol-roundtrip` e2e);
// test/webview/editor.test.ts case (e) additionally characterizes the CM
// seam's defensive fallback. This corpus carries no mixed-EOL or lone-CR
// fixture, so the gate deliberately asserts byte-identity only for the
// uniform-EOL class.
//
// `cmRoundTrip` drives editor.ts's seed→read byte path through the SAME
// production helpers it uses: `splitToCmText` (split on /\r\n?|\n/ into a
// CodeMirror `Text`) + `detectLineSeparator` (the whole-doc `lineSeparator`
// facet), imported from src/webview/cm/seed.ts — NOT re-implemented here, so
// the gate and production cannot silently drift. It then reads back via
// `sliceDoc()`. The production wrapper `editor.ts#applyDocument` is byte-pinned
// independently by test/webview/editor.test.ts (cases (a)/(e)/(f): CRLF, LF,
// mixed-EOL, paste). No EditorView/DOM is needed — the byte contract lives
// entirely in @codemirror/state (cm/seed.ts is DOM-free), so this stays in the
// node test environment.
//
// CONTRAST WITH THE PM ERA: the old bridge (markdownToProseMirror →
// proseMirrorToMarkdown) silently REWROTE the user's bytes — hard-break
// collapse, reference-image drop, autolink rewrite, table column re-padding,
// task-marker flip, CRLF→LF, trailing-whitespace strip. The previous EXPECTED
// map encoded those lossy transforms as the contract, which re-encoded a bug as
// a guarantee. EX_PM_DIVERGENCES below documents each former divergence as a
// DOCUMENTED IMPROVEMENT the CM surface delivers (bytes preserved), NOT a
// regression. The gate asserts text-identity; it never asserts PM-era output.

/** Seed `source` into the canonical CM doc and read it back — the exact byte
 *  path editor.ts#applyDocument drives (`splitToCmText` + the `lineSeparator`
 *  facet from `detectLineSeparator`, both imported from src/webview/cm/seed.ts),
 *  minus the DOM view. */
function cmRoundTrip(source: string): string {
  const state = EditorState.create({
    doc: splitToCmText(source),
    extensions: [EditorState.lineSeparator.of(detectLineSeparator(source))],
  });
  return state.sliceDoc();
}

// Fixtures whose PM-bridge round-trip used to DIVERGE from the source. Under
// the CM surface every one is now byte-identical; the note records what the PM
// bridge did and why preserving the bytes is an improvement, not a regression.
// The first six are the headline divergences called out in the C9a slice; the
// C6a table fixtures below them carry the same class of mdast normalization
// (already pinned at the serializer layer by test/markdown/table/
// round-trip.test.ts) and now reach identity through the whole-doc CM surface.
const EX_PM_DIVERGENCES: Record<string, string> = {
  "hard-break-ambiguity.md":
    "PM/mdast collapsed both two-space and backslash hard breaks to the backslash form. CM preserves each break exactly as written.",
  "relative-images.md":
    "PM inlined the reference-style image and DROPPED the trailing `[img-ref]:` definition. CM keeps the reference usage and its definition verbatim.",
  "autolinks.md":
    "PM rewrote bare-URL/email autolinks to `<…>` and `www.` autolinks to `[text](http://text)`. CM leaves the original autolink text untouched.",
  "inline-pipes-in-code.md":
    "Fixture's primary concern: a `|` inside inline code must not be parsed as a table-cell delimiter. PM/mdast also re-padded the embedded table's columns (incl. the escaped-pipe code rows) to the per-column minimum width. CM preserves both the inline-code bytes and the author's column padding.",
  "table-alignment.md":
    "PM re-padded columns and widened centered alignment markers to the body width. CM preserves the exact delimiter row and padding.",
  "mixed-task-bullet.md":
    "PM flipped bare bullets in a task list to a `[ ]` prefix. CM preserves bare bullets alongside `[x]` items.",
  "gfm-table-crlf.md":
    "PM normalized CRLF line endings to LF. CM detects the whole-doc separator and preserves the \\r\\n bytes.",
  "table-trailing-line-ws.md":
    "PM stripped trailing whitespace after the closing `|`. CM preserves the trailing bytes.",
  "table-empty-cells.md":
    "PM re-padded columns to the per-column minimum, including empty cells. CM preserves the author's padding.",
  "table-1col-pipeless-body.md":
    "PM normalized pipeless body rows to leading-and-trailing-pipe form and re-padded the column. CM preserves the pipeless rows verbatim.",
  "table-in-cell-link.md":
    "PM re-padded the column to the longest-cell width, dropping a trailing space. CM preserves the author's padding.",
  "table-multi-backslash.md":
    "PM reinterpreted a trailing `\\|` and re-padded the column. CM preserves the exact escaped-backslash and pipe bytes.",
};

describe("round-trip parity gate: CM surface is text-identity", () => {
  const fixtures = loadFixtures();

  // `source` is the fixture BODY after the single `<!-- case: … -->` header is
  // stripped (load-fixtures.ts#stripCaseHeader) — i.e. the Markdown the editor
  // would receive from the host, not the on-disk file (whose line 1 is
  // reviewer-only metadata). Byte-identity is asserted on that body.
  it.each(fixtures)("$name: body round-trips byte-identically through the CM surface", ({
    source,
  }) => {
    expect(cmRoundTrip(source)).toBe(source);
  });

  // Keep the ex-divergence annotations honest in BOTH directions. Forward: no
  // key may name a fixture that does not exist (catches a typo/rename to a
  // missing file). Backward: pin the EXACT key set — the 6 headline divergences
  // plus the 6 C6a table fixtures — so a silent DELETE, REPLACE (swap a key for
  // another real fixture name), or accidental ADD fails here instead of quietly
  // leaving the suite green while forgetting a PM-era divergence. Editing this
  // set is the deliberate "bump on purpose" point. (Identity itself is already
  // asserted for every fixture by the it.each above; re-asserting it here would
  // add no coverage.)
  it("the documented ex-PM-divergence set is exactly the known PM-lossy fixtures", () => {
    const byName = new Map(fixtures.map((f) => [`${f.name}.md`, f]));
    for (const file of Object.keys(EX_PM_DIVERGENCES)) {
      expect(byName.get(file), `EX_PM_DIVERGENCES names a missing fixture: ${file}`).toBeDefined();
    }
    expect(new Set(Object.keys(EX_PM_DIVERGENCES))).toEqual(
      new Set([
        "hard-break-ambiguity.md",
        "relative-images.md",
        "autolinks.md",
        "inline-pipes-in-code.md",
        "table-alignment.md",
        "mixed-task-bullet.md",
        "gfm-table-crlf.md",
        "table-trailing-line-ws.md",
        "table-empty-cells.md",
        "table-1col-pipeless-body.md",
        "table-in-cell-link.md",
        "table-multi-backslash.md",
      ])
    );
  });

  // Scope sentinel: make the documented uniform-EOL limitation (see SCOPE
  // LIMITATION above) EXECUTABLE rather than prose the gate merely relies on. A
  // future mixed-EOL or lone-CR fixture would be normalized by the CM text
  // layer and fail the it.each with an opaque byte-diff; this fails first with a
  // clear "outside this gate's scope" message pointing the author at the right
  // remedy (a separate suite or normalising the fixture).
  it("the fixture corpus stays within the uniform-EOL scope this gate covers", () => {
    for (const { name, source } of fixtures) {
      const loneCR = /\r(?!\n)/.test(source);
      const mixedCrlfWithBareLf =
        source.includes("\r\n") && source.replace(/\r\n/g, "").includes("\n");
      expect(
        loneCR || mixedCrlfWithBareLf,
        `${name}: mixed-EOL / lone-CR is outside this gate's uniform-EOL scope (see SCOPE LIMITATION)`
      ).toBe(false);
    }
  });
});
