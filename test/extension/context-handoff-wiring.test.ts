import { describe, expect, it } from "vitest";

import { createContextHandoffWiring } from "../../src/extension/context-handoff-wiring.js";
import type { EditSettledBarrier } from "../../src/extension/edit-settled-barrier.js";

// A fake barrier that CAPTURES the (run, onDrop) pair without running it — the
// wiring's single-flight / disposed routing is observable without triggering the
// real vscode reveal choreography inside the thunk.
function makeCaptureBarrier(): {
  barrier: EditSettledBarrier;
  calls: { run: () => void; onDrop?: () => void }[];
} {
  const calls: { run: () => void; onDrop?: () => void }[] = [];
  const barrier: EditSettledBarrier = {
    run: (run, onDrop) => {
      calls.push({ run, onDrop });
    },
    settle: () => {},
  };
  return { barrier, calls };
}

// Minimal document — never read on these paths (the captured thunks are not run).
const fakeDocument = {
  uri: { scheme: "file", toString: () => "file:///doc.md" },
  isDirty: false,
} as never;

function makeWiring(barrier: EditSettledBarrier, isDisposed: () => boolean) {
  return createContextHandoffWiring({
    document: fakeDocument,
    viewType: "quoll.editMarkdown",
    editSettledBarrier: barrier,
    isDisposed,
  });
}

describe("createContextHandoffWiring", () => {
  it("defers a context-handoff through the barrier", () => {
    const { barrier, calls } = makeCaptureBarrier();
    const wiring = makeWiring(barrier, () => false);
    wiring.handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 });
    expect(calls).toHaveLength(1);
  });

  it("defers a codex-context-handoff through the barrier with an onDrop release", () => {
    const { barrier, calls } = makeCaptureBarrier();
    const wiring = makeWiring(barrier, () => false);
    wiring.handleCodexContextHandoff();
    expect(calls).toHaveLength(1);
    // The Codex arm MUST supply an onDrop so a dropped deferred thunk releases
    // the single-flight guard (the Claude arm has none — no receipt guard).
    expect(calls[0].onDrop).toBeTypeOf("function");
  });

  it("drops both arms when disposed (no barrier.run)", () => {
    const { barrier, calls } = makeCaptureBarrier();
    const wiring = makeWiring(barrier, () => true);
    wiring.handleContextHandoff({ hasSelection: false, startLine: 1, endLine: 1 });
    wiring.handleCodexContextHandoff();
    expect(calls).toHaveLength(0);
  });

  it("single-flights Codex: a second call while the first is in flight is dropped", () => {
    const { barrier, calls } = makeCaptureBarrier();
    const wiring = makeWiring(barrier, () => false);
    wiring.handleCodexContextHandoff();
    wiring.handleCodexContextHandoff(); // in flight → dropped
    expect(calls).toHaveLength(1);
  });

  it("releases the Codex single-flight guard when the deferred thunk is DROPPED (onDrop)", () => {
    const { barrier, calls } = makeCaptureBarrier();
    const wiring = makeWiring(barrier, () => false);
    wiring.handleCodexContextHandoff();
    expect(calls).toHaveLength(1);
    // Simulate a failed-apply drop: the barrier fires the captured onDrop.
    calls[0].onDrop?.();
    // Guard released → a later handoff is accepted again.
    wiring.handleCodexContextHandoff();
    expect(calls).toHaveLength(2);
  });
});
