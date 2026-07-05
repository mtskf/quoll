// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTreeAvailable } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  fencedCodeCollapseField,
  fencedCodeCollapseFieldFullRecompute,
} from "../../src/webview/cm/decorations/fenced-code-collapse.js";
import { setFencedCollapseEffect } from "../../src/webview/cm/decorations/fenced-code-collapse-state.js";

const exts = (): Extension[] => [
  EditorState.allowMultipleSelections.of(true),
  markdown({ base: markdownLanguage }),
  fencedCodeCollapseField,
  fencedCodeCollapseFieldFullRecompute,
];

interface Row {
  key: number;
  blockFrom: number;
  blockTo: number;
  expanded: boolean;
  hiddenCount: number;
  decoFrom: number;
  decoTo: number;
}
function rows(view: EditorView, full: boolean): Row[] {
  const s = view.state.field(full ? fencedCodeCollapseFieldFullRecompute : fencedCodeCollapseField);
  return s.blocks.map((b) => ({
    key: b.key,
    blockFrom: b.blockFrom,
    blockTo: b.blockTo,
    expanded: b.expanded,
    hiddenCount: b.hiddenCount,
    decoFrom: b.decoFrom,
    decoTo: b.decoTo,
  }));
}
function decoRanges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}
function assertEquivalent(view: EditorView): void {
  // Compare the BOUNDED field to the full-recompute oracle field (Codex finding 4:
  // compare blocks, not only decorations — expanded point widgets hide blockTo).
  expect(rows(view, false)).toEqual(rows(view, true));
  expect(decoRanges(view.state.field(fencedCodeCollapseField).decorations)).toEqual(
    decoRanges(view.state.field(fencedCodeCollapseFieldFullRecompute).decorations)
  );
}

function fence(body: number, lang = "js"): string {
  return `\`\`\`${lang}\n${Array.from({ length: body }, (_, i) => `code line ${i}`).join("\n")}\n\`\`\``;
}

interface Edit {
  changes?: { from: number; to?: number; insert?: string };
  // `EditorSelection.cursor(...)` yields a SelectionRange; `.create(...)` an
  // EditorSelection. dispatch accepts either (SelectionRange structurally matches
  // TransactionSpec's `{anchor, head?}`), so the battery uses both.
  selection?: EditorSelection | SelectionRange;
  effect?: { key: number; expanded: boolean };
}

function run(initial: string, edits: Edit[]): void {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: initial, extensions: exts() }),
    parent,
  });
  try {
    forceParsing(view, view.state.doc.length, 10_000);
    assertEquivalent(view); // create() equivalence on the fully-parsed initial doc
    for (const e of edits) {
      view.dispatch({
        changes: e.changes,
        selection: e.selection,
        effects: e.effect ? setFencedCollapseEffect.of(e.effect) : undefined,
      });
      const len = view.state.doc.length;
      // Assert BEFORE forceParsing when the post-edit tree is already complete — the
      // bounded branch ran during dispatch, so this catches a bounded bug a self-heal
      // would mask (tableSkeletonField R2-2 / Codex finding 5).
      if (syntaxTreeAvailable(view.state, len)) {
        assertEquivalent(view);
      }
      forceParsing(view, len, 10_000); // publish → converge (also covers the G2 path)
      assertEquivalent(view);
    }
  } finally {
    view.destroy();
  }
}

describe("fencedCodeCollapseField bounded ≡ full", () => {
  const F = fence(15); // closed, 15 body lines → collapsible
  const cases: Array<{ name: string; initial: string; edits: Edit[] }> = [
    {
      name: "type prose far above a block",
      initial: `# Top\n\nprose\n\n${F}\n\ntail`,
      edits: [{ changes: { from: 2, insert: "x" }, selection: EditorSelection.cursor(3) }],
    },
    {
      name: "edit a visible head body line → hiddenCount/geometry shift",
      initial: `${F}\n`,
      edits: [{ changes: { from: 10, insert: "ZZ" } }],
    },
    {
      name: "delete head body lines → block drops below threshold",
      initial: `${fence(11)}\n`,
      edits: [{ changes: { from: 6, to: 6 + "code line 0\ncode line 1\n".length } }],
    },
    {
      name: "insert a whole block before an existing one",
      initial: `${F}\n\n${F}\n`,
      edits: [{ changes: { from: 0, insert: `${F}\n\n` } }],
    },
    {
      name: "GF: type a new closing fence mid-body re-pairs",
      initial: `${fence(30)}\n`,
      edits: [
        {
          changes: { from: fence(30).indexOf("code line 12"), insert: "```\n\nplain\n\n```txt\n" },
        },
      ],
    },
    {
      name: "GF: delete the closing fence uncloses the block",
      initial: `${F}\nafter\n`,
      edits: [{ changes: { from: F.length - 4, to: F.length } }],
    },
    {
      name: "GF: unclosed fence — append at EOF grows the block",
      initial: `\`\`\`js\n${Array.from({ length: 15 }, (_, i) => `x${i}`).join("\n")}`,
      edits: [
        {
          changes: {
            from: `\`\`\`js\n${Array.from({ length: 15 }, (_, i) => `x${i}`).join("\n")}`.length,
            insert: "\nx15\nx16",
          },
        },
      ],
    },
    {
      name: "GF: delete a list marker promotes a nested fence to top-level",
      initial: `- item\n\n  ${fence(12).split("\n").join("\n  ")}\n\ntail`,
      edits: [{ changes: { from: 0, to: 2 } }], // delete "- "
    },
    // Pins that the fence arm of STRUCTURAL is load-bearing: deleting block A's closing
    // ``` leaves it unclosed, so the parser re-pairs with block B's opener — block B (a
    // DISTANT node outside the edit span) vanishes. Without the fence arm, the bounded
    // path reuses a stale prevBlocks record for B and diverges from the oracle.
    {
      name: "GF non-local: delete block A's closing fence re-pairs a DISTANT block B",
      initial: `${fence(15)}\n\nprose between the two blocks\n\n${fence(15)}\n`,
      edits: [{ changes: { from: fence(15).length - 3, to: fence(15).length } }], // delete block A's closing ```
    },
    // Pins the HTML arm of STRUCTURAL: deleting </script> collapses the whole doc into
    // one HTMLBlock, swallowing the distant fence(15) — it vanishes from the top-level
    // tree. Without the HTML arm, bounded reuses a stale record for the fence.
    {
      name: "GF HTML: delete a </script> before a distant fence (HTMLBlock swallows it)",
      initial: `<script>\nvar x = 1;\n</script>\n\nprose\n\n${fence(15)}\n`,
      edits: [
        {
          changes: {
            from: "<script>\nvar x = 1;\n".length,
            to: "<script>\nvar x = 1;\n</script>\n".length,
          },
        },
      ], // delete the </script> line incl its newline
    },
    // topLevelBlankRisk: a type-6/7 HTML block (`<div>`) is TERMINATED by a blank line, so
    // deleting the blank line that ends it extends the block over everything up to the next
    // blank — here 20 prose lines AND the following top-level fence — WITHOUT touching any
    // tag/marker line, so STRUCTURAL is blind to it. The fence sits FAR below the deleted
    // blank (outside the ±1-line span AND untouched), so computeBounded would reuse its stale
    // record; the post-edit tree is fully available (verified: syntaxTreeAvailable === true)
    // so G2 does NOT mask this. The blank deletion is a top-level newline delete →
    // topLevelBlankRisk fires → full recompute. Drop topLevelBlankRisk from the GF condition
    // and this goes RED (bounded keeps the swallowed fence's stale record; oracle has none).
    {
      name: "GF blank-line: deleting the blank that ends an HTML block swallows a DISTANT fence",
      initial: `<div>\nhtml text\n\n${Array.from({ length: 20 }, (_, i) => `prose ${i}`).join(
        "\n"
      )}\n${fence(15)}\n`,
      edits: [
        {
          // delete the blank line right after "html text" (a bare \n)
          changes: { from: "<div>\nhtml text\n".length, to: "<div>\nhtml text\n\n".length },
        },
      ],
    },
    // The mirror of the case above: TYPING a char into the blank line that terminates the
    // HTML block makes it non-blank → the boundary disappears the same way, swallowing the
    // DISTANT fence. No newline delta and no deletion — only a blankness flip (blank→non-
    // blank), which topLevelBlankRisk detects via oldBlank !== newBlank. Drop that flip
    // check (leave only the newline delta) and this goes RED (Codex cycle-3).
    {
      name: "GF blank-line: typing into the blank that ends an HTML block swallows a DISTANT fence",
      initial: `<div>\nhtml text\n\n${Array.from({ length: 20 }, (_, i) => `prose ${i}`).join(
        "\n"
      )}\n${fence(15)}\n`,
      edits: [
        {
          // insert "x" INTO the blank line right after "html text" (blank → non-blank)
          changes: { from: "<div>\nhtml text\n".length, insert: "x" },
        },
      ],
    },
    // Isolates the STRUCTURAL HTML arm (the `</script>` case above deletes a newline, so
    // topLevelBlankRisk's newlineDelta masks the HTML arm). Typing `<!--` IN PLACE at a
    // non-blank line start opens a type-2 HTML block that swallows the DISTANT fence with
    // NO newline delta and NO blankness flip — only the HTML arm catches it. Drop the HTML
    // arm and this goes RED (test-analyzer finding 1).
    {
      name: "GF HTML in-place: typing `<!--` at a non-blank line start swallows a DISTANT fence",
      initial: `prose here\n\n${fence(15)}\n`,
      edits: [{ changes: { from: 0, insert: "<!--" } }],
    },
    // Isolates the UNanchored type-1 close-tag arm (`</script|pre|style|textarea>`): a
    // CLOSED <script> block whose `</script>` sits MID-LINE. Breaking the mid-line close
    // tag un-closes the block → it swallows the DISTANT fence. The changed line is not
    // line-start `<`, no newline, no blank flip — only the unanchored close-tag arm (via the
    // OLD slice still containing `</script>`) catches it. Drop that arm and this goes RED
    // (code-quality mid-line finding).
    {
      name: "GF HTML mid-line: breaking a mid-line </script> swallows a DISTANT fence",
      initial: `<script>\nvar x = 1; </script> tail\n\n${Array.from({ length: 20 }, (_, i) =>
        `prose ${i}`
      ).join("\n")}\n${fence(15)}\n`,
      edits: [
        {
          // insert a space inside `</script>` → `</scr ipt>`, no longer a valid close tag
          changes: { from: "<script>\nvar x = 1; </scr".length, insert: " " },
        },
      ],
    },
    // Isolates topLevelBlankRisk's newlineDelta arm (the delete-blank case is masked by the
    // blankness flip). A MULTI-LINE deletion removes an interior blank boundary while BOTH
    // the changed-range start and end lines stay non-blank (so oldBlank === newBlank and the
    // flip is blind); only newlineDelta catches it. The extended <div> swallows the DISTANT
    // fence. Force newlineDelta false and this goes RED (test-analyzer finding 2).
    {
      name: "GF blank-line: multi-line delete removes an interior blank boundary (no flip), DISTANT fence",
      initial: `<div>\nhtml text\n\n${Array.from({ length: 20 }, (_, i) => `prose ${i}`).join(
        "\n"
      )}\n${fence(15)}\n`,
      edits: [{ changes: { from: "<div>\nhtml ".length, to: "<div>\nhtml text\n\npr".length } }],
    },
    // fence(10) has exactly 10 body lines = COLLAPSE_THRESHOLD → NOT collapsible. The
    // insert is plain prose/code (no STRUCTURAL match) → bounded path. After the insert
    // the block has 11 body lines > threshold → collapsible. computeBounded discovers it
    // via the span overlap (FencedCode at pos 0 overlaps the changed-line span) even
    // though it was absent from prevBlocks.
    {
      name: "threshold cross-UP: a 10-line block grows past the threshold via a bounded body edit",
      initial: `${fence(10)}\n\ntail prose\n`,
      edits: [
        { changes: { from: `${fence(10)}`.indexOf("code line 9"), insert: "grown line\ncode " } },
      ],
    },
    // Pins the empirical finding (parser-probed): a blank-line-only edit does NOT flip a
    // fence's containment, so the bounded path (no STRUCTURAL match) stays correct. If a
    // future parser change ever makes blank lines regroup a fence's container, THIS goes
    // red first and forces the guard broadening the comment above deliberately omits.
    {
      name: "blank-line-only edit near a nested fence keeps containment (bounded stays sound)",
      initial: `- item\n\n  ${fence(12).split("\n").join("\n  ")}\n\ntail prose\n`,
      edits: [
        {
          changes: {
            from: `- item\n\n  ${fence(12).split("\n").join("\n  ")}\n`.length,
            insert: "\n",
          },
        },
      ],
    },
    // Pins CONTAINMENT-CORRECTNESS through the GF full-recompute path: the edit at
    // position 6 removes the list-item line's own trailing \n, touching the "- item"
    // line → STRUCTURAL fires (list marker arm) → GF full recompute → containment stays
    // correct. Does NOT exercise the bounded path (see the nested-fence blank-line case
    // above and the verbatim-reuse .toBe identity test for bounded-path coverage).
    {
      name: "blank edit touching list marker → GF full recompute → fence stays top-level",
      initial: `- item\n\n${F}\n`,
      edits: [{ changes: { from: 6, to: 7 } }], // removes list-item's trailing \n → STRUCTURAL fires
    },
    {
      name: "expanded block, then edit far below → point-widget reuse",
      initial: `${F}\n\nmid prose\n\n${fence(20)}\n`,
      edits: [
        { effect: { key: 0, expanded: true } },
        { changes: { from: `${F}\n\nmid`.length, insert: "X" } },
      ],
    },
    {
      name: "caret into then out of a concealed region (sticky auto-expand)",
      initial: `${F}\n\nbelow`,
      edits: [
        { selection: EditorSelection.cursor(F.indexOf("code line 12")) },
        { selection: EditorSelection.cursor(F.length + 2) },
      ],
    },
    {
      name: "multi-cursor far apart with an edit",
      initial: `${F}\n\nmid\n\n${F}\n\ntail`,
      edits: [
        {
          changes: { from: F.length + 3, insert: "q" },
          selection: EditorSelection.create([
            EditorSelection.cursor(F.length + 4),
            EditorSelection.cursor(1),
          ]),
        },
      ],
    },
  ];
  for (const c of cases) {
    it(c.name, () => run(c.initial, c.edits));
  }
});

it("reuses an untouched far block's record VERBATIM on a bounded keystroke", () => {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const F = fence(15);
  // Block at the TOP; edit far BELOW it so no position shifts → shiftRecord returns
  // the record verbatim (reference-identity). A full recompute would allocate a NEW
  // record object, so === distinguishes bounded reuse from full recompute. The initial
  // caret is parked far BELOW the block too: computeExtendedSpan unions the OLD selection
  // (needed so an auto-expand-leave rebuilds), so a default cursor at 0 would land the
  // span on the top block and force a rebuild — defeating the verbatim-reuse we assert.
  const doc = `${F}\n\nprose tail here\n`;
  const editPos = `${F}\n\nprose tail`.length; // far below the block
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(editPos),
      extensions: exts(),
    }),
    parent,
  });
  try {
    forceParsing(view, view.state.doc.length, 10_000);
    const before = view.state.field(fencedCodeCollapseField).blocks[0];
    view.dispatch({
      changes: { from: editPos, insert: "X" },
      selection: EditorSelection.cursor(editPos + 1),
    });
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true); // bounded branch ran
    const after = view.state.field(fencedCodeCollapseField).blocks[0];
    expect(after).toBe(before); // SAME object — only verbatim bounded reuse yields this
    // Oracle (always full) allocates fresh → NOT identical, but VALUE-equal.
    expect(view.state.field(fencedCodeCollapseFieldFullRecompute).blocks[0]).not.toBe(before);
  } finally {
    view.destroy();
  }
});
