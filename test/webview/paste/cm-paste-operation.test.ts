// @vitest-environment happy-dom
import { history, redo, redoDepth, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";

import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
import {
  completingPasteOperation,
  pendingPasteOperations,
  registerPasteOperation,
} from "../../../src/webview/cm/paste/paste-operation.js";

import { firePasteAt } from "../helpers/clipboard-double.js";

function pending(from: number, to = from, id = "A") {
  return { id, from, to, selectionMoved: false };
}

function stateWith(...targets: ReturnType<typeof pending>[]) {
  const state = EditorState.create({
    doc: "0123456789abcdefghij",
    extensions: [pendingPasteOperations],
  });
  return state.update({ effects: targets.map((target) => registerPasteOperation.of(target)) })
    .state;
}

it("pending full range maps through preceding edits", () => {
  const state = stateWith(pending(4, 8), pending(12, 12, "B"));
  const live = state.update({ changes: { from: 1, insert: "abc" } }).state;
  expect(live.field(pendingPasteOperations)).toEqual([pending(7, 11), pending(15, 15, "B")]);
  expect(state.field(pendingPasteOperations)).toEqual([pending(4, 8), pending(12, 12, "B")]);
});

it("editing replacement interior cancels pending operation", () => {
  for (const changes of [
    { from: 5, insert: "x" },
    { from: 3, to: 6 },
    { from: 6, to: 9 },
    { from: 4, to: 8 },
  ]) {
    expect(
      stateWith(pending(4, 8)).update({ changes }).state.field(pendingPasteOperations)
    ).toEqual([]);
  }
  for (const changes of [
    { from: 2, to: 4 },
    { from: 8, to: 10 },
    { from: 4, insert: "x" },
    { from: 8, insert: "x" },
  ]) {
    const state = stateWith(pending(4, 8));
    const tr = state.update({ changes });
    expect(tr.state.field(pendingPasteOperations)).toEqual([
      pending(tr.changes.mapPos(4, 1), tr.changes.mapPos(8, -1)),
    ]);
  }
});

it("deletion strictly across pending caret cancels", () => {
  const state = stateWith(pending(6));
  expect(state.update({ changes: { from: 5, to: 7 } }).state.field(pendingPasteOperations)).toEqual(
    []
  );
});

it("boundary deletion preserves caret and same-position typing maps right", () => {
  for (const [changes, position] of [
    [{ from: 4, to: 6 }, 4],
    [{ from: 6, to: 8 }, 6],
    [{ from: 6, insert: "abc" }, 9],
  ] as const) {
    expect(stateWith(pending(6)).update({ changes }).state.field(pendingPasteOperations)).toEqual([
      pending(position),
    ]);
  }
});

it("selection movement metadata survives document mapping", () => {
  const state = stateWith(pending(6));
  const moved = state.update({ selection: { anchor: 10 } }).state;
  expect(moved.field(pendingPasteOperations)).toEqual([{ ...pending(6), selectionMoved: true }]);
  const live = moved.update({ changes: { from: 1, insert: "abc" } }).state;
  expect(live.field(pendingPasteOperations)).toEqual([{ ...pending(9), selectionMoved: true }]);
  expect(moved.doc.eq(state.doc)).toBe(true);
  expect(state.update({ selection: state.selection }).state.field(pendingPasteOperations)).toEqual([
    pending(6),
  ]);
});

it("successful undo preserves redo after late result", () => {
  const view = new EditorView({ doc: "base", extensions: [history(), pendingPasteOperations] });
  try {
    view.dispatch({ effects: registerPasteOperation.of(pending(1)) });
    expect(undo(view)).toBe(false);
    expect(view.state.field(pendingPasteOperations)).toEqual([pending(1)]);
    view.dispatch({ changes: { from: 4, insert: "typed" }, userEvent: "input.type" });
    expect(undo(view)).toBe(true);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(redoDepth(view.state)).toBe(1);
    // A late callback may insert only while its operation id remains live.
    if (view.state.field(pendingPasteOperations).some((target) => target.id === "A")) {
      view.dispatch({ changes: { from: 1, insert: "late" } });
    }
    expect(redoDepth(view.state)).toBe(1);
    view.dispatch({ effects: registerPasteOperation.of(pending(1, 1, "B")) });
    expect(redo(view)).toBe(true);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(view.state.doc.toString()).toBe("basetyped");
  } finally {
    view.destroy();
  }
});

it("changed reseed cancels but identical ack retains pending target", () => {
  const state = stateWith(pending(6));
  const ack = state.update({ annotations: hostDocumentReseed.of(true) }).state;
  expect(ack.field(pendingPasteOperations)).toEqual([pending(6)]);
  expect(ack.doc.eq(state.doc)).toBe(true);
  const changed = ack.update({
    changes: { from: 0, to: 1, insert: "x" },
    annotations: hostDocumentReseed.of(true),
  }).state;
  expect(changed.field(pendingPasteOperations)).toEqual([]);
});

it("new conflicting custom paste supersedes old", () => {
  for (const [a, b] of [
    [pending(6), pending(6, 6, "B")],
    [pending(4, 8), pending(6, 10, "B")],
    [pending(4, 8), pending(4, 4, "B")],
    [pending(8), pending(4, 8, "B")],
  ]) {
    const state = stateWith(a, pending(15, 16, "C"));
    const live = state.update({ effects: registerPasteOperation.of(b) }).state;
    expect(live.field(pendingPasteOperations)).toEqual([pending(15, 16, "C"), b]);
    expect(state.field(pendingPasteOperations)).toEqual([a, pending(15, 16, "C")]);
    expect(live.doc.eq(state.doc)).toBe(true);
  }
  const state = stateWith(pending(4, 8));
  expect(
    state
      .update({ effects: registerPasteOperation.of(pending(8, 10, "B")) })
      .state.field(pendingPasteOperations)
  ).toEqual([pending(4, 8), pending(8, 10, "B")]);
});

function copyText(view: EditorView): string {
  const copied = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      clearData: () => copied.clear(),
      setData: (type: string, value: string) => copied.set(type, value),
    },
  });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  return copied.get("text/plain")!;
}

it("linewise CM paste cancels at its actual insertion point", () => {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    doc: "source\nTARGET\nother",
    extensions: [pendingPasteOperations],
  });
  try {
    view.dispatch({ selection: { anchor: 2 } });
    view.focus();
    const copied = copyText(view);
    expect(copied).toBe("source");
    view.dispatch({ selection: { anchor: 10 } });
    view.dispatch({
      effects: [
        registerPasteOperation.of(pending(7)),
        registerPasteOperation.of(pending(18, 18, "B")),
      ],
    });
    firePasteAt(view.contentDOM, { text: copied });
    expect(view.state.doc.toString()).toBe("source\nsource\nTARGET\nother");
    expect(view.state.field(pendingPasteOperations)).toEqual([pending(25, 25, "B")]);
    // Coordinator completion excludes its own id from paste-conflict cancellation.
    view.dispatch({ effects: registerPasteOperation.of(pending(0, 0, "own")) });
    view.dispatch({
      changes: { from: 0, insert: "x" },
      userEvent: "input.paste",
      annotations: completingPasteOperation.of("own"),
    });
    expect(view.state.field(pendingPasteOperations).find((target) => target.id === "own")).toEqual(
      pending(1, 1, "own")
    );
  } finally {
    view.destroy();
    parent.remove();
  }
});

it("secondary CM paste range cancels its conflicting operation", () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: "0123456789abcdefghij",
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(10)]),
      extensions: [EditorState.allowMultipleSelections.of(true), pendingPasteOperations],
    }),
  });
  try {
    view.dispatch({
      effects: [
        registerPasteOperation.of(pending(10)),
        registerPasteOperation.of(pending(18, 18, "B")),
      ],
    });
    firePasteAt(view.contentDOM, { text: "x\ny" });
    expect(view.state.doc.toString()).toBe("01x23456789yabcdefghij");
    expect(view.state.field(pendingPasteOperations)).toEqual([
      { ...pending(20, 20, "B"), selectionMoved: true },
    ]);
  } finally {
    view.destroy();
  }
});

it("filtered CM paste cancels only actual changed ranges", () => {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "source\nTARGET\nother",
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        pendingPasteOperations,
        EditorView.clipboardInputFilter.of(() => "source"),
      ],
    }),
  });
  try {
    view.dispatch({ selection: { anchor: 2 } });
    view.focus();
    expect(copyText(view)).toBe("source");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(10)]),
    });
    view.dispatch({
      effects: [
        registerPasteOperation.of(pending(0)),
        registerPasteOperation.of(pending(2, 2, "B")),
        registerPasteOperation.of(pending(10, 10, "C")),
      ],
    });
    // The filter turns two input lines into the last linewise copy. Native CM
    // therefore inserts whole lines at 0 and 7, rather than at the two carets.
    firePasteAt(view.contentDOM, { text: "x\ny" });
    expect(view.state.doc.toString()).toBe("source\nsource\nsource\nTARGET\nother");
    expect(view.state.field(pendingPasteOperations)).toEqual([
      pending(9, 9, "B"),
      pending(24, 24, "C"),
    ]);
  } finally {
    view.destroy();
    parent.remove();
  }
});

it("vetoed CM paste preserves pending operations", () => {
  for (const keepPasteAnnotation of [false, true]) {
    const view = new EditorView({ state: stateWith(pending(0), pending(8, 12, "B")) });
    try {
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          EditorState.transactionFilter.of((tr) =>
            tr.isUserEvent("input.paste")
              ? keepPasteAnnotation
                ? { userEvent: "input.paste" }
                : []
              : tr
          )
        ),
      });
      const before = view.state;
      firePasteAt(view.contentDOM, { text: "blocked" });
      expect(view.state.doc.eq(before.doc)).toBe(true);
      expect(view.state.selection.eq(before.selection)).toBe(true);
      expect(view.state.field(pendingPasteOperations)).toEqual(
        before.field(pendingPasteOperations)
      );
    } finally {
      view.destroy();
    }
  }
});
