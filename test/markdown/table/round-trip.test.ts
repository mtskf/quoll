// test/markdown/table/round-trip.test.ts
// Pure C6a round-trip: every table block in every fixture parses,
// serializes, and matches the source byte-for-byte. This is the
// "text-identity" gate that contrasts with the PM-padded outputs
// asserted by test/markdown/round-trip.test.ts (still on the PM bridge).
import { describe, expect, it } from "vitest";
import { tableAlign } from "../../../src/markdown/table/model.js";
import { parseAllTables } from "../../../src/markdown/table/parse.js";
import { serializeTable } from "../../../src/markdown/table/serialize.js";
import { loadFixtures } from "../load-fixtures.js";

const TABLE_BEARING_FIXTURES: { name: string; expectedTables: number }[] = [
  { name: "gfm-table", expectedTables: 1 },
  { name: "table-alignment", expectedTables: 2 },
  { name: "inline-pipes-in-code", expectedTables: 1 },
  { name: "table-in-cell-link", expectedTables: 1 },
  { name: "table-in-cell-image", expectedTables: 1 },
  { name: "table-trailing-line-ws", expectedTables: 1 },
  { name: "table-multi-backslash", expectedTables: 1 },
  { name: "gfm-table-crlf", expectedTables: 1 },
  { name: "table-empty-cells", expectedTables: 1 },
  { name: "table-1col-pipeless-body", expectedTables: 1 },
];

describe("c6a table round-trip (text-identity)", () => {
  const fixtures = loadFixtures();
  const byName = new Map(fixtures.map((f) => [f.name, f]));

  for (const { name, expectedTables } of TABLE_BEARING_FIXTURES) {
    it(`${name}: every table block round-trips byte-identically`, () => {
      const fixture = byName.get(name);
      expect(fixture).toBeDefined();
      if (!fixture) {
        return;
      }

      const tables = parseAllTables(fixture.source);
      expect(tables).toHaveLength(expectedTables);
      for (const t of tables) {
        const sourceSlice = fixture.source.slice(t.from, t.to);
        expect(serializeTable(t)).toBe(sourceSlice);
      }
    });
  }
});

describe("c6a table-alignment.md column align byte-preservation", () => {
  const fixtures = loadFixtures();
  const fixture = fixtures.find((f) => f.name === "table-alignment");

  it("preserves the exact delimiter cells incl. :--- / :---: / ---:", () => {
    expect(fixture).toBeDefined();
    if (!fixture) {
      return;
    }
    const tables = parseAllTables(fixture.source);
    // First table: header is "Default | Left | Center | Right".
    expect(tableAlign(tables[0])).toEqual([null, "left", "center", "right"]);
    expect(tables[0].delimiter.cells.map((c) => c.raw)).toEqual([
      " ------- ",
      " :---- ",
      " :----: ",
      " ----: ",
    ]);
  });
});
