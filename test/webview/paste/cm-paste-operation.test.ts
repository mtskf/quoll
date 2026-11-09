// @vitest-environment happy-dom
import { history, redo, redoDepth, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, StateEffect, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";

import { frontmatterBlockField } from "../../../src/webview/cm/frontmatter/frontmatter-field.js";
import { revealFrontmatterAt } from "../../../src/webview/cm/frontmatter/reveal-state.js";

import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
import {
  completingPasteOperation,
  composePasteReplacement,
  createPasteOperationCoordinator,
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

function coordinatorFixture(reject = false) {
  const failure = vi.fn();
  const coordinator = createPasteOperationCoordinator({ onFailure: failure });
  const view = new EditorView({
    doc: "base",
    extensions: [
      coordinator.extension,
      ...(reject ? [EditorState.transactionFilter.of(() => [])] : []),
    ],
  });
  const capture = () => coordinator.capture(view, { from: 1, to: 2, render: () => "caption" });
  return { coordinator, view, failure, capture };
}

it("registration veto leaves no new pending operation", () => {
  const f = coordinatorFixture(true);
  try {
    const before = f.view.state;
    expect(f.capture()).toBeNull();
    expect(f.view.state.field(pendingPasteOperations)).toEqual([]);
    expect(f.view.state.doc.eq(before.doc)).toBe(true);
    expect(f.view.state.selection.eq(before.selection)).toBe(true);
    expect(f.failure).toHaveBeenCalledOnce();
  } finally {
    f.view.destroy();
  }
});

it("registration rejection starts zero reads posts and timers", () => {
  const read = vi.fn(class {});
  vi.stubGlobal("FileReader", read);
  const timer = vi.spyOn(globalThis, "setTimeout");
  const post = vi.fn();
  const startResources = vi.fn(() => {
    new FileReader();
    post();
    const deadline = setTimeout(() => {}, 30_000);
    return () => clearTimeout(deadline);
  });
  const coordinator = createPasteOperationCoordinator({ onFailure: vi.fn(), startResources });
  const view = new EditorView({
    extensions: [coordinator.extension, EditorState.transactionFilter.of(() => [])],
  });
  try {
    read.mockClear();
    timer.mockClear();
    expect(coordinator.capture(view, { from: 0, to: 0, render: () => "x" }, 1)).toBeNull();
    expect(startResources).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    const allowed = new EditorView({ extensions: [coordinator.extension] });
    try {
      coordinator.capture(allowed, { from: 0, to: 0, render: () => "x" });
      expect(startResources).toHaveBeenCalledOnce();
    } finally {
      allowed.destroy();
    }
  } finally {
    view.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("rejected registration retains existing conflicting operation", () => {
  const f = coordinatorFixture();
  try {
    const id = f.capture()!;
    f.view.dispatch({
      effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of(() => [])),
    });
    expect(f.capture()).toBeNull();
    expect(f.view.state.field(pendingPasteOperations).map((target) => target.id)).toEqual([id]);
    expect(f.coordinator.has(id)).toBe(true);
    expect(f.failure).toHaveBeenCalledOnce();
  } finally {
    f.view.destroy();
  }
});

it("registration dispatch throw starts no I/O", () => {
  const startResources = vi.fn();
  const failure = vi.fn();
  const coordinator = createPasteOperationCoordinator({ onFailure: failure, startResources });
  const view = new EditorView({ extensions: [coordinator.extension] });
  try {
    vi.spyOn(view, "dispatch").mockImplementation(() => {
      throw new Error("dispatch failed");
    });
    expect(coordinator.capture(view, { from: 0, to: 0, render: () => "x" })).toBeNull();
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(startResources).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
  } finally {
    view.destroy();
  }
});

it("post-adoption registration throw clears new metadata", () => {
  const startResources = vi.fn();
  const failure = vi.fn();
  const coordinator = createPasteOperationCoordinator({ onFailure: failure, startResources });
  const view = new EditorView({ extensions: [coordinator.extension] });
  try {
    const dispatch = view.dispatch.bind(view);
    vi.spyOn(view, "dispatch").mockImplementationOnce((...input) => {
      dispatch(...input);
      throw new Error("adopted then failed");
    });
    expect(coordinator.capture(view, { from: 0, to: 0, render: () => "x" })).toBeNull();
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(startResources).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
    expect(coordinator.has("paste-1")).toBe(false);
  } finally {
    view.destroy();
  }
});

it("reverse replies preserve slot order", () => {
  const f = coordinatorFixture();
  try {
    const id = f.coordinator.capture(f.view, { from: 1, to: 2, render: () => "caption" }, 3)!;
    f.coordinator.settle(id, 2, "./c.png");
    f.coordinator.settle(id, 0, "./a.png");
    f.coordinator.settle(id, 1, null);
    expect(f.coordinator.results(id)).toEqual(["./a.png", null, "./c.png"]);
    expect(f.view.state.doc.toString()).toBe("base");
  } finally {
    f.view.destroy();
  }
});

it("duplicate reply cannot settle twice", () => {
  const f = coordinatorFixture();
  try {
    const id = f.coordinator.capture(f.view, { from: 1, to: 2, render: () => "x" }, 2)!;
    f.coordinator.settle(id, 0, "./first.png");
    f.coordinator.settle(id, 0, null);
    expect(f.coordinator.results(id)).toEqual(["./first.png", undefined]);
    f.coordinator.settle(id, 1, null);
    f.coordinator.settle(id, 1, "./duplicate.png");
    expect(f.coordinator.results(id)).toEqual(["./first.png", null]);
  } finally {
    f.view.destroy();
  }
});

it("operation becomes ready only after its last slot", () => {
  const ready = vi.fn();
  const coordinator = createPasteOperationCoordinator({ onFailure: vi.fn(), onReady: ready });
  const view = new EditorView({ extensions: [coordinator.extension] });
  try {
    const id = coordinator.capture(view, { from: 0, to: 0, render: () => "x" }, 3)!;
    coordinator.settle(id, 2, null);
    coordinator.settle(id, 0, "./a.png");
    coordinator.settle(id, 0, "./duplicate.png");
    expect(ready).not.toHaveBeenCalled();
    coordinator.settle(id, 1, null);
    expect(ready).toHaveBeenCalledExactlyOnceWith(id);
    coordinator.settle(id, 1, null);
    expect(ready).toHaveBeenCalledOnce();
    const textOnly = coordinator.capture(view, { from: 0, to: 0, render: () => "text" })!;
    expect(ready).toHaveBeenLastCalledWith(textOnly);
  } finally {
    view.destroy();
  }
});

it("composed replacement keeps text and accepted links in order", () => {
  const state = EditorState.create({ doc: "before TARGET after" });
  const render = vi.fn((live: EditorState, from: number, to: number) => {
    expect(live).toBe(state);
    expect([from, to]).toEqual([7, 13]);
    return "caption\r\nsecond";
  });
  const replacement = composePasteReplacement(state, { from: 0, to: 0, render }, pending(7, 13), [
    "./a.png",
    null,
    "./c.png",
  ]);
  expect(replacement.toString()).toBe("caption\nsecond\n![](./a.png)\n![](./c.png)\n");
  expect(replacement.length).toBe(replacement.toString().length);
  expect(render).toHaveBeenCalledOnce();
  expect(state.doc.toString()).toBe("before TARGET after");
  expect(
    composePasteReplacement(state, { from: 0, to: 0, render: () => "  - item\n" }, pending(0, 7), [
      "./a.png",
    ]).toString()
  ).toBe("  - item\n![](./a.png)\n");
});

it("accepted replacement dispatches the same filtered transaction once", () => {
  const f = coordinatorFixture();
  try {
    const id = f.coordinator.capture(f.view, { from: 1, to: 2, render: () => "caption" }, 1)!;
    const filtered: import("@codemirror/state").Transaction[] = [];
    let documentChanges = 0;
    f.view.dispatch({
      effects: StateEffect.appendConfig.of([
        EditorState.transactionFilter.of((tr) => {
          filtered.push(tr);
          return tr;
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            documentChanges++;
          }
        }),
      ]),
    });
    const dispatch = vi.spyOn(f.view, "dispatch");
    f.coordinator.settle(id, 0, "./a.png");
    f.coordinator.complete(id);
    expect(filtered).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(filtered[0]);
    expect(documentChanges).toBe(1);
    expect(f.view.state.doc.toString()).toBe("bcaption\n![](./a.png)\nse");
    expect(f.view.state.selection.main.head).toBe("bcaption\n![](./a.png)\n".length);
    expect(f.coordinator.has(id)).toBe(false);
    expect(f.view.state.field(pendingPasteOperations)).toEqual([]);
  } finally {
    f.view.destroy();
  }
});

it("reject-all filter clears pending metadata without inserting", () => {
  const failure = vi.fn();
  const unlinked = vi.fn();
  const coordinator = createPasteOperationCoordinator({
    onFailure: failure,
    onUnlinkedPath: unlinked,
  });
  const view = new EditorView({ doc: "base", extensions: [coordinator.extension] });
  try {
    const id = coordinator.capture(view, { from: 1, to: 2, render: () => "caption" }, 1)!;
    view.dispatch({
      effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of(() => [])),
    });
    const before = view.state;
    coordinator.settle(id, 0, "./a.png");
    coordinator.complete(id);
    expect(view.state.doc.eq(before.doc)).toBe(true);
    expect(view.state.selection.eq(before.selection)).toBe(true);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(coordinator.has(id)).toBe(false);
    expect(failure).toHaveBeenCalledOnce();
    expect(unlinked).toHaveBeenCalledExactlyOnceWith("./a.png");
    coordinator.settle(id, 0, "./a.png");
    coordinator.complete(id);
    expect(view.state.doc.eq(before.doc)).toBe(true);
    expect(failure).toHaveBeenCalledOnce();
  } finally {
    view.destroy();
  }
});

it("collapsed frontmatter rejects paste without leaking pending work", () => {
  const failure = vi.fn();
  const unlinked = vi.fn();
  const coordinator = createPasteOperationCoordinator({
    onFailure: failure,
    onUnlinkedPath: unlinked,
  });
  const view = new EditorView({
    doc: "---\ntitle: test\n---\nbody",
    extensions: [coordinator.extension, frontmatterBlockField],
  });
  try {
    expect(revealFrontmatterAt(view, 7)).toBe(true);
    expect(view.state.field(frontmatterBlockField).kind).toBe("revealed");
    const id = coordinator.capture(view, { from: 7, to: 7, render: () => "caption" }, 1)!;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.state.field(frontmatterBlockField).kind).toBe("collapsed");
    const before = view.state;
    coordinator.settle(id, 0, "./a.png");
    coordinator.complete(id);
    expect(view.state.doc.eq(before.doc)).toBe(true);
    expect(view.state.selection.eq(before.selection)).toBe(true);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(coordinator.has(id)).toBe(false);
    expect(failure).toHaveBeenCalledOnce();
    expect(unlinked).toHaveBeenCalledExactlyOnceWith("./a.png");
    coordinator.complete(id);
    expect(failure).toHaveBeenCalledOnce();
  } finally {
    view.destroy();
  }
});

it("completed paste undoes and redoes as one step", () => {
  const startResources = vi.fn();
  const coordinator = createPasteOperationCoordinator({ onFailure: vi.fn(), startResources });
  const view = new EditorView({ doc: "base", extensions: [coordinator.extension, history()] });
  try {
    view.dispatch({
      changes: { from: 4, insert: "before" },
      selection: { anchor: 10 },
      userEvent: "input.type",
    });
    const id = coordinator.capture(view, { from: 10, to: 10, render: () => "caption" }, 2)!;
    coordinator.settle(id, 1, "./b.png");
    coordinator.settle(id, 0, "./a.png");
    coordinator.complete(id);
    const pasted = view.state.doc.toString();
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "after" },
      userEvent: "input.type",
    });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(pasted);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("basebefore");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("base");
    expect(redo(view)).toBe(true);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(pasted);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${pasted}after`);
    expect(startResources).toHaveBeenCalledOnce();
  } finally {
    view.destroy();
  }
});

it("superseding B times out without reviving A", () => {
  vi.useFakeTimers();
  const failure = vi.fn();
  const ready = vi.fn((id: string) => coordinator.complete(id));
  const coordinator = createPasteOperationCoordinator({ onFailure: failure, onReady: ready });
  const view = new EditorView({ doc: "base", extensions: [coordinator.extension] });
  try {
    const a = coordinator.capture(view, { from: 1, to: 2, render: () => "A" }, 1)!;
    const b = coordinator.capture(view, { from: 1, to: 2, render: () => "B" }, 2)!;
    coordinator.settle(a, 0, "./late-a.png");
    coordinator.settle(b, 1, "./b.png");
    expect(view.state.doc.toString()).toBe("base");
    vi.advanceTimersByTime(29_999);
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(view.state.doc.toString()).toBe("bB\n![](./b.png)\nse");
    expect(ready).toHaveBeenCalledExactlyOnceWith(b);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(coordinator.has(a)).toBe(false);
    expect(coordinator.has(b)).toBe(false);
    const settled = view.state.doc;
    coordinator.settle(a, 0, "./late-a.png");
    coordinator.settle(b, 0, "./late-b.png");
    vi.advanceTimersByTime(30_000);
    expect(view.state.doc.eq(settled)).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
  } finally {
    view.destroy();
    vi.useRealTimers();
  }
});

it("dispose aborts readers and clears timers", () => {
  vi.useFakeTimers();
  const readers: FileReader[] = [];
  const ready = vi.fn();
  const coordinator = createPasteOperationCoordinator({
    onFailure: vi.fn(),
    onReady: ready,
    startResources: () => {
      const reader = new FileReader();
      readers.push(reader);
      vi.spyOn(reader, "abort");
      return () => reader.abort();
    },
  });
  const view = new EditorView({ doc: "base", extensions: [coordinator.extension] });
  try {
    const timersBefore = vi.getTimerCount();
    const id = coordinator.capture(view, { from: 1, to: 2, render: () => "caption" }, 1)!;
    expect(vi.getTimerCount()).toBeGreaterThan(timersBefore);
    coordinator.dispose();
    expect(readers[0].abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(coordinator.has(id)).toBe(false);
    coordinator.settle(id, 0, "./late.png");
    coordinator.complete(id);
    vi.advanceTimersByTime(30_000);
    expect(view.state.doc.toString()).toBe("base");
    expect(ready).not.toHaveBeenCalled();
    expect(coordinator.capture(view, { from: 0, to: 0, render: () => "late" }, 1)).toBeNull();
    coordinator.dispose();
    expect(readers[0].abort).toHaveBeenCalledOnce();
    const abort = vi.fn();
    const destroyed = createPasteOperationCoordinator({
      onFailure: vi.fn(),
      onReady: ready,
      startResources: () => abort,
    });
    const other = new EditorView({ extensions: [destroyed.extension] });
    const otherId = destroyed.capture(other, { from: 0, to: 0, render: () => "x" }, 1)!;
    other.destroy();
    expect(abort).toHaveBeenCalledOnce();
    destroyed.settle(otherId, 0, "./late.png");
    destroyed.complete(otherId);
    vi.advanceTimersByTime(30_000);
    expect(other.state.doc.toString()).toBe("");
    expect(ready).not.toHaveBeenCalled();
  } finally {
    view.destroy();
    vi.useRealTimers();
  }
});

it.each([
  "construction",
  "dispatch",
  "normalization",
])("precommit failure preserves document and terminates operation (%s)", (stage) => {
  vi.useFakeTimers();
  const onFailure = vi.fn();
  const onUnlinkedPath = vi.fn();
  const release = vi.fn();
  const coordinator = createPasteOperationCoordinator({
    onFailure,
    onUnlinkedPath,
    startResources: () => release,
  });
  const view = new EditorView({
    doc: "target",
    selection: { anchor: 0, head: 6 },
    extensions: [coordinator.extension],
  });
  try {
    const id = coordinator.capture(view, { from: 0, to: 6, render: () => "caption" }, 1)!;
    const before = view.state;
    coordinator.settle(id, 0, "./unlinked.png");
    if (stage === "construction") {
      const update = before.update.bind(before);
      vi.spyOn(before, "update").mockImplementation((...specs: TransactionSpec[]) => {
        if (specs.some((spec) => spec.changes)) {
          throw new Error("construction failed");
        }
        return update(...specs);
      });
    } else if (stage === "dispatch") {
      const dispatch = view.dispatch.bind(view);
      vi.spyOn(view, "dispatch").mockImplementation((...args: Parameters<typeof view.dispatch>) => {
        if (args[0] && "docChanged" in args[0] && args[0].docChanged) {
          throw new Error("dispatch failed");
        }
        dispatch(...args);
      });
    } else {
      vi.spyOn(before, "toText").mockImplementationOnce(() => {
        throw new Error("normalization failed");
      });
    }
    expect(() => coordinator.complete(id)).not.toThrow();
    expect(view.state.doc.eq(before.doc)).toBe(true);
    expect(view.state.selection.eq(before.selection)).toBe(true);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(coordinator.results(id)).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onUnlinkedPath).toHaveBeenCalledExactlyOnceWith("./unlinked.png");
    coordinator.settle(id, 0, "./late.png");
    coordinator.complete(id);
    vi.advanceTimersByTime(30_000);
    expect(view.state.doc.eq(before.doc)).toBe(true);
    expect(onFailure).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    view.destroy();
    vi.useRealTimers();
  }
});

it("throwing live render terminates once and reports unlinked path", () => {
  vi.useFakeTimers();
  const onFailure = vi.fn();
  const onUnlinkedPath = vi.fn();
  const release = vi.fn();
  const render = vi.fn(() => {
    throw new Error("render failed");
  });
  const coordinator = createPasteOperationCoordinator({
    onFailure,
    onUnlinkedPath,
    startResources: () => release,
  });
  const view = new EditorView({ doc: "target", extensions: [coordinator.extension] });
  try {
    const id = coordinator.capture(view, { from: 0, to: 6, render }, 1)!;
    const before = view.state;
    coordinator.settle(id, 0, "./unlinked.png");
    expect(() => coordinator.complete(id)).not.toThrow();
    expect(view.state.doc.eq(before.doc)).toBe(true);
    expect(view.state.selection.eq(before.selection)).toBe(true);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(coordinator.results(id)).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onUnlinkedPath).toHaveBeenCalledExactlyOnceWith("./unlinked.png");
    coordinator.settle(id, 0, "./late.png");
    coordinator.complete(id);
    vi.advanceTimersByTime(30_000);
    expect(render).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(view.state.doc.eq(before.doc)).toBe(true);
  } finally {
    view.destroy();
    vi.useRealTimers();
  }
});

it("postcommit failure never reinserts", () => {
  vi.useFakeTimers();
  const onFailure = vi.fn();
  const release = vi.fn();
  const coordinator = createPasteOperationCoordinator({ onFailure, startResources: () => release });
  let edits = 0;
  const view = new EditorView({
    doc: "target",
    extensions: [
      coordinator.extension,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          edits++;
        }
      }),
    ],
  });
  try {
    const id = coordinator.capture(view, { from: 0, to: 6, render: () => "caption" }, 1)!;
    coordinator.settle(id, 0, "./accepted.png");
    const dispatch = view.dispatch.bind(view);
    const spy = vi
      .spyOn(view, "dispatch")
      .mockImplementation((...args: Parameters<typeof view.dispatch>) => {
        dispatch(...args);
        if (args[0] && "docChanged" in args[0] && args[0].docChanged) {
          throw new Error("postcommit failed");
        }
      });
    expect(() => coordinator.complete(id)).not.toThrow();
    expect(view.state.doc.toString()).toBe("caption\n![](./accepted.png)\n");
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    expect(coordinator.results(id)).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    coordinator.settle(id, 0, "./late.png");
    coordinator.complete(id);
    vi.advanceTimersByTime(30_000);
    expect(edits).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("caption\n![](./accepted.png)\n");
  } finally {
    vi.restoreAllMocks();
    view.destroy();
    vi.useRealTimers();
  }
});
