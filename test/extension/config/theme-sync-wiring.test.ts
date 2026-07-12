import { describe, expect, it, vi } from "vitest";

import {
  createThemeSyncWiring,
  type ThemeSyncWiringDeps,
} from "../../../src/extension/config/theme-sync-wiring.js";

function makeWiring(overrides: Partial<ThemeSyncWiringDeps> = {}) {
  let onThemeChange: ((isDarkTheme: boolean) => void) | null = null;
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
    emit: (isDark: boolean) => {
      if (onThemeChange === null) {
        throw new Error("subscribe handler not captured");
      }
      onThemeChange(isDark);
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
    emit(true);
    emit(false);
    expect(spies.onThemeChange.mock.calls).toEqual([[true], [false]]);
  });

  it("tears down the subscription on dispose", () => {
    const h = makeWiring();
    expect(h.wasUnsubscribed()).toBe(false);
    h.wiring.dispose();
    expect(h.wasUnsubscribed()).toBe(true);
  });
});
