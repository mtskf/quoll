// Arrow-key intercept for block-widget zones.
//
// CodeMirror's default cursor-vertical movement treats a `block: true`
// Decoration.replace as a single atomic step — so ArrowUp/Down across a
// table widget leapfrogs the entire table source. This keymap reads the
// `quollBlockReplaceZones` facet (the same one C4a's orchestrator uses to
// drop inline marks inside block widgets) and, when the natural next-line
// step would cross a zone the caret currently sits outside, dispatches a
// caret on the zone's first / last source line instead. That caret lands
// on a widget line → the widget's StateField (e.g. tableBlockField) sees
// the line-level overlap → the widget hides → the source becomes
// editable. The user can then keep arrow-stepping inside the source.
//
// Scope intentionally narrow:
//   - Single-cursor only (empty main range, no multi-cursor).
//   - No goal-column preservation (caret lands at zone.from / zone.to,
//     which is line.from / line.to of the widget's first / last line).
//     Adding goal-column tracking is a deliberate future polish — KISS
//     for the first slice.
//   - Pass-through (returns false) on every other shape so CM's default
//     ArrowUp/Down keymap runs as usual.

import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";

import { quollBlockReplaceZones } from "./orchestrator.js";

function moveAcrossZone(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const zones = state.facet(quollBlockReplaceZones);
  if (zones.length === 0) {
    return false;
  }
  if (state.selection.ranges.length !== 1) {
    return false;
  }
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }

  const head = range.head;
  const line = state.doc.lineAt(head);

  // Compute the first byte of the NEXT line in `dir`. No next line ⇒
  // we're at the doc edge ⇒ defer to defaults (which will no-op).
  let nextLineProbe: number;
  if (dir === 1) {
    if (line.to >= state.doc.length) {
      return false;
    }
    nextLineProbe = line.to + 1;
  } else {
    if (line.from <= 0) {
      return false;
    }
    nextLineProbe = line.from - 1;
  }

  // Is that probe byte inside any zone? Zones are line-aligned and
  // half-open in `arbitrate`, but reveal-on-caret in tableBlockField is
  // closed (line.from / line.to inclusive). Match the FIELD semantics
  // here so "caret AT zone.to" counts as inside (and we land on the
  // zone's last line, which the field then reveals).
  for (const z of zones) {
    if (nextLineProbe >= z.from && nextLineProbe <= z.to) {
      const anchor = dir === 1 ? z.from : z.to;
      // Already there? (Pathological — same-tick double-fire.) No-op.
      if (anchor === head) {
        return false;
      }
      view.dispatch({ selection: { anchor }, scrollIntoView: true, userEvent: "select" });
      return true;
    }
  }
  return false;
}

export const blockZoneArrowDown: Command = (view) => moveAcrossZone(view, 1);
export const blockZoneArrowUp: Command = (view) => moveAcrossZone(view, -1);

/** Extension entry — registered AFTER any block-widget StateField that
 *  contributes to `quollBlockReplaceZones`. Prec.high so the two
 *  ArrowUp/Down bindings run BEFORE `defaultKeymap`'s cursorLineDown /
 *  cursorLineUp, which would otherwise skip the widget atomically. */
export function blockZoneArrowKeymap(): Extension {
  return Prec.high(
    keymap.of([
      { key: "ArrowDown", run: blockZoneArrowDown },
      { key: "ArrowUp", run: blockZoneArrowUp },
    ])
  );
}
