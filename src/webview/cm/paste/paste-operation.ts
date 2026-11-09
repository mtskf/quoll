// Pending paste metadata and its async coordinator.
import { isolateHistory } from "@codemirror/commands";
import { Annotation, type EditorState, MapMode, StateEffect, StateField } from "@codemirror/state";

import { type EditorView, ViewPlugin } from "@codemirror/view";

import { hostDocumentReseed } from "../host-reseed.js";

export interface PendingPasteOperation {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly selectionMoved: boolean;
}

export const completingPasteOperation = Annotation.define<string>();

export const registerPasteOperation = StateEffect.define<PendingPasteOperation>();
const removePasteOperation = StateEffect.define<string>();

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
      if (effect.is(removePasteOperation)) {
        next = next.filter((target) => target.id !== effect.value);
      }
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

export interface PasteDecision {
  readonly from: number;
  readonly to: number;
  readonly render: (state: EditorState, from: number, to: number) => string;
}

export function createPasteOperationCoordinator(options: {
  onFailure: () => void;
  startResources?: (id: string) => (() => void) | undefined;
  onReady?: (id: string) => void;
  onUnlinkedPath?: (path: string) => void;
}) {
  let nextId = 0;
  let disposed = false;
  const operations = new Map<
    string,
    {
      view: EditorView;
      decision: PasteDecision;
      slots: (string | null | undefined)[];
      deadline?: ReturnType<typeof setTimeout>;
      release?: () => void;
    }
  >();
  function clearMetadata(view: EditorView, id: string) {
    if (!view.state.field(pendingPasteOperations).some((target) => target.id === id)) {
      return;
    }
    // Only private metadata bypasses filters; content edits always remain filtered.
    const tr = view.state.update({ effects: removePasteOperation.of(id), filter: false });
    if (!tr.newDoc.eq(view.state.doc)) {
      throw new Error("Paste cleanup must preserve the document");
    }
    view.dispatch(tr);
  }
  function release(id: string) {
    const operation = operations.get(id);
    operations.delete(id);
    clearTimeout(operation?.deadline);
    operation?.release?.();
    return operation;
  }
  function dispose(clearState = true) {
    disposed = true;
    for (const [id, operation] of operations) {
      release(id);
      if (clearState) {
        clearMetadata(operation.view, id);
      }
      for (const path of operation.slots) {
        if (typeof path === "string") {
          options.onUnlinkedPath?.(path);
        }
      }
    }
  }
  function isLive(id: string) {
    const operation = operations.get(id);
    return !!operation?.view.state.field(pendingPasteOperations).some((target) => target.id === id);
  }
  function settle(id: string, slot: number, path: string | null) {
    const operation = operations.get(id);
    if (!operation || !isLive(id) || slot < 0 || slot >= operation.slots.length) {
      return;
    }
    if (operation.slots[slot] !== undefined) {
      return;
    }
    operation.slots[slot] = path;
    if (operation.slots.every((result) => result !== undefined)) {
      clearTimeout(operation.deadline);
      options.onReady?.(id);
    }
  }
  function fail(view: EditorView, id: string) {
    const operation = release(id);
    clearMetadata(view, id);
    for (const path of operation?.slots ?? []) {
      if (typeof path === "string") {
        options.onUnlinkedPath?.(path);
      }
    }
    options.onFailure();
  }
  return {
    extension: [
      pendingPasteOperations,
      ViewPlugin.define(() => ({
        update(update) {
          for (const [id, operation] of operations) {
            if (
              operation.view !== update.view ||
              isLive(id) ||
              update.transactions.some((tr) => tr.annotation(completingPasteOperation) === id)
            ) {
              continue;
            }
            release(id);
            for (const path of operation.slots) {
              if (typeof path === "string") {
                options.onUnlinkedPath?.(path);
              }
            }
            // Notices may dispatch, so deliver them outside CM's update.
            queueMicrotask(() => {
              if (!disposed) {
                options.onFailure();
              }
            });
          }
        },
        destroy() {
          dispose(false);
        },
      })),
    ],
    dispose: () => dispose(),
    capture(view: EditorView, decision: PasteDecision, slotCount = 0): string | null {
      if (disposed) {
        return null;
      }
      const id = `paste-${++nextId}`;
      try {
        view.dispatch({
          effects: registerPasteOperation.of({
            id,
            from: decision.from,
            to: decision.to,
            selectionMoved: false,
          }),
        });
      } catch {
        clearMetadata(view, id);
        options.onFailure();
        return null;
      }
      if (!view.state.field(pendingPasteOperations).some((target) => target.id === id)) {
        options.onFailure();
        return null;
      }
      operations.set(id, { view, decision, slots: Array.from({ length: slotCount }) });
      const cleanup = options.startResources?.(id);
      const operation = operations.get(id);
      if (operation) {
        operation.release = cleanup;
      } else {
        cleanup?.();
      }
      if (operation?.slots.some((result) => result === undefined)) {
        operation.deadline = setTimeout(() => {
          if (!isLive(id)) {
            operations.delete(id);
            return;
          }
          operation.slots.forEach((result, slot) => {
            if (result === undefined) {
              settle(id, slot, null);
            }
          });
        }, 30_000);
      }
      if (slotCount === 0) {
        options.onReady?.(id);
      }
      return id;
    },
    complete(id: string) {
      const operation = operations.get(id);
      if (!operation || operation.slots.some((result) => result === undefined)) {
        return;
      }
      const { view, decision, slots } = operation;
      const target = view.state.field(pendingPasteOperations).find((entry) => entry.id === id);
      if (!target) {
        return;
      }
      const state = view.state;
      try {
        const insert = composePasteReplacement(state, decision, target, slots);
        if (!insert.length) {
          fail(view, id);
          return;
        }
        const spec = {
          changes: { from: target.from, to: target.to, insert },
          selection: target.selectionMoved ? undefined : { anchor: target.from + insert.length },
          scrollIntoView: !target.selectionMoved,
          userEvent: "input.paste",
          annotations: [completingPasteOperation.of(id), isolateHistory.of("full")],
          effects: removePasteOperation.of(id),
        };
        const expected = state.changes(spec.changes).apply(state.doc);
        const tr = state.update(spec);
        if (!tr.newDoc.eq(expected)) {
          fail(view, id);
          return;
        }
        view.dispatch(tr);
        release(id);
        clearMetadata(view, id);
      } catch {
        if (view.state !== state) {
          // Adoption is terminal even when dispatch did not finish successfully.
          release(id);
          clearMetadata(view, id);
          options.onFailure();
          return;
        }
        fail(view, id);
      }
    },
    settle,
    results: (id: string) => operations.get(id)?.slots.slice(),
    has: isLive,
  };
}

/** Normalize before computing separators or offsets. The decision already owns indentation. */
export function composePasteReplacement(
  state: EditorState,
  decision: PasteDecision,
  target: PendingPasteOperation,
  slots: readonly (string | null | undefined)[]
) {
  let text = state.toText(decision.render(state, target.from, target.to));
  const paths = slots.filter((path): path is string => typeof path === "string");
  if (paths.length) {
    const atLineStart = target.from === state.doc.lineAt(target.from).from;
    const prefix = text.length
      ? text.sliceString(text.length - 1) === "\n"
        ? ""
        : "\n"
      : atLineStart
        ? ""
        : "\n";
    text = text.append(state.toText(prefix + paths.map((path) => `![](${path})\n`).join("")));
  }
  return text;
}
