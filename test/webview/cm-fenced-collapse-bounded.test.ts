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
    {
      name: "blank-line-only edit between a list and a top-level fence keeps it top-level",
      initial: `- item\n\n${F}\n`,
      edits: [{ changes: { from: 6, to: 7 } }], // delete one of the blank-separating newlines
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
