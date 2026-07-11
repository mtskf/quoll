import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDITOR_PREF_DEFAULTS, EDITOR_PREF_ENUMS } from "../../src/shared/protocol.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const props = pkg.contributes.configuration.properties as Record<
  string,
  { enum?: string[]; default?: string; enumDescriptions?: string[] }
>;

describe("package.json editor-preset settings ↔ protocol constants", () => {
  for (const key of Object.keys(EDITOR_PREF_ENUMS) as (keyof typeof EDITOR_PREF_ENUMS)[]) {
    it(`${key} declares the exact enum from EDITOR_PREF_ENUMS`, () => {
      expect(props[key]).toBeDefined();
      expect(props[key].enum).toEqual([...EDITOR_PREF_ENUMS[key]]);
    });
    it(`${key} default matches EDITOR_PREF_DEFAULTS`, () => {
      expect(props[key].default).toBe(EDITOR_PREF_DEFAULTS[key]);
    });
    it(`${key} has one enumDescription per id`, () => {
      expect(props[key].enumDescriptions?.length).toBe(EDITOR_PREF_ENUMS[key].length);
    });
  }
});
