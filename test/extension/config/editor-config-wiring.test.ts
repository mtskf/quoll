import { describe, expect, it, vi } from "vitest";

import {
  createEditorConfigWiring,
  type EditorConfigWiringDeps,
} from "../../../src/extension/config/editor-config-wiring.js";

function makeWiring(overrides: Partial<EditorConfigWiringDeps> = {}) {
  let onRelevantChange: (() => void) | null = null;
  let unsubscribed = false;
  const spies = { push: vi.fn() };
  const deps: EditorConfigWiringDeps = {
    subscribe: (handler) => {
      onRelevantChange = handler;
      return () => {
        unsubscribed = true;
      };
    },
    push: spies.push,
    ...overrides,
  };
  const wiring = createEditorConfigWiring(deps);
  return {
    wiring,
    spies,
    fireRelevantChange: () => {
      if (onRelevantChange === null) {
        throw new Error("subscribe handler not captured");
      }
      onRelevantChange();
    },
    wasUnsubscribed: () => unsubscribed,
  };
}

describe("createEditorConfigWiring", () => {
  it("does not push at construction (pushes are seed / ready / change driven only)", () => {
    const { spies } = makeWiring();
    expect(spies.push).not.toHaveBeenCalled();
  });

  it("pushes on an explicit push() call (seed / ready handshakes)", () => {
    const { wiring, spies } = makeWiring();
    wiring.push();
    wiring.push();
    expect(spies.push).toHaveBeenCalledTimes(2);
  });

  it("pushes when the subscription reports a relevant change", () => {
    const { spies, fireRelevantChange } = makeWiring();
    fireRelevantChange();
    expect(spies.push).toHaveBeenCalledTimes(1);
  });

  it("tears down the subscription on dispose", () => {
    const h = makeWiring();
    expect(h.wasUnsubscribed()).toBe(false);
    h.wiring.dispose();
    expect(h.wasUnsubscribed()).toBe(true);
  });
});
