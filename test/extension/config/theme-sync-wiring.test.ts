import { describe, expect, it, vi } from "vitest";

import {
  createThemeSyncWiring,
  type ThemeSyncWiringDeps,
} from "../../../src/extension/config/theme-sync-wiring.js";
import type { ThemeKind } from "../../../src/shared/protocol.js";

function makeWiring(overrides: Partial<ThemeSyncWiringDeps> = {}) {
  let onThemeChange: ((themeKind: ThemeKind) => void) | null = null;
  let unsubscribed = false;
  const spies = { onThemeChange: vi.fn() };
  const deps: ThemeSyncWiringDeps = {
    subscribe: (handler) => {
      onThemeChange = handler;
      return () => {
        unsubscribed = true;
      };
    },
    onThemeChange: spies.onThemeChange,
    ...overrides,
  };
  const wiring = createThemeSyncWiring(deps);
  return {
    wiring,
    spies,
    emit: (themeKind: ThemeKind) => {
      if (onThemeChange === null) {
        throw new Error("subscribe handler not captured");
      }
      onThemeChange(themeKind);
    },
    wasUnsubscribed: () => unsubscribed,
  };
}

describe("createThemeSyncWiring", () => {
  it("does not forward anything at construction (only on a real signal)", () => {
    const { spies } = makeWiring();
    expect(spies.onThemeChange).not.toHaveBeenCalled();
  });

  it("subscribes at construction and forwards the theme signal to onThemeChange", () => {
    const { spies, emit } = makeWiring();
    emit("dark");
    emit("light");
    emit("hc-dark");
    expect(spies.onThemeChange.mock.calls).toEqual([["dark"], ["light"], ["hc-dark"]]);
  });

  it("tears down the subscription on dispose", () => {
    const h = makeWiring();
    expect(h.wasUnsubscribed()).toBe(false);
    h.wiring.dispose();
    expect(h.wasUnsubscribed()).toBe(true);
  });
});
