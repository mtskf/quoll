// Pending paste metadata only. Async resources belong to the coordinator.
import { Annotation, MapMode, StateEffect, StateField } from "@codemirror/state";

import { hostDocumentReseed } from "../host-reseed.js";

export interface PendingPasteOperation {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly selectionMoved: boolean;
}

export const completingPasteOperation = Annotation.define<string>();

export const registerPasteOperation = StateEffect.define<PendingPasteOperation>();

function rangesConflict(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  if (a.from === a.to) {
    return a.from >= b.from && a.from <= b.to;
  }
  if (b.from === b.to) {
    return b.from >= a.from && b.from <= a.to;
  }
  return a.from < b.to && b.from < a.to;
}

export const pendingPasteOperations = StateField.define<readonly PendingPasteOperation[]>({
  create: () => [],
  update(value, tr) {
    if (tr.annotation(hostDocumentReseed) && tr.docChanged) {
      return [];
    }
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) {
      return [];
    }
    const completingId = tr.annotation(completingPasteOperation);
    let next = value
      .filter((target) => {
        if (tr.docChanged && tr.isUserEvent("input.paste") && target.id !== completingId) {
          let conflict = false;
          tr.changes.iterChanges((from, to) => {
            if (rangesConflict(target, { from, to })) {
              conflict = true;
            }
          });
          if (conflict) {
            return false;
          }
        }
        if (target.from === target.to) {
          return tr.changes.mapPos(target.from, 1, MapMode.TrackDel) !== null;
        }
        let overwritten = false;
        if (target.from !== target.to) {
          tr.changes.iterChanges((from, to) => {
            if (from < target.to && to > target.from) {
              overwritten = true;
            }
          });
        }
        return !overwritten;
      })
      .map((target) => {
        const from = tr.changes.mapPos(target.from, 1);
        const to = target.from === target.to ? from : tr.changes.mapPos(target.to, -1);
        const selectionMoved =
          target.selectionMoved ||
          (!!tr.selection && !tr.newSelection.eq(tr.startState.selection.map(tr.changes)));
        return { ...target, from, to, selectionMoved };
      });
    for (const effect of tr.effects) {
      if (effect.is(registerPasteOperation)) {
        next = [
          ...next.filter((target) => !rangesConflict(target, effect.value)),
          { ...effect.value },
        ];
      }
    }
    return next;
  },
});
