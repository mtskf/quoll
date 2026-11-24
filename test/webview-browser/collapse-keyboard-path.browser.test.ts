// Real-browser pin for the keyboard path to the "Show more" / "Show less" bars, through the
// REAL production bundle (every keymap editor.ts wires, Tab-owning list-indent included).
// Every case starts from editor focus and drives real key events — never button.click().
//   - editable: the fold keys (Cmd-Alt-[ / ] on macOS, Ctrl-Shift-[ / ] elsewhere) collapse
//     and expand the long block at the caret (cm/collapse/collapse-keymap.ts);
//   - read-only: the content is not a focus target, so Tab reaches the bar's button natively
//     and Enter toggles it.

import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { productionPasteFixture } from "./helpers/production-paste-fixture.js";

type Fixture = Awaited<ReturnType<typeof productionPasteFixture>>;
let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.frame.remove();
  fixture = undefined;
});

const body = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}line${i + 1}`).join("\n");
const CASES = [
  { name: "fenced code", doc: `\`\`\`\n${body(14, "")}\n\`\`\`\n\npara\n`, bar: "fenced" },
  { name: "blockquote", doc: `${body(14, "> ")}\n\npara\n`, bar: "blockquote" },
] as const;

const toggleOf = (f: Fixture, bar: string) => {
  const t = f.win.document.querySelectorAll<HTMLButtonElement>(`.quoll-${bar}-collapse-toggle`);
  expect(t.length).toBe(1);
  return t[0] as HTMLButtonElement;
};
const expanded = (f: Fixture, bar: string) => toggleOf(f, bar).getAttribute("aria-expanded");

// CodeMirror resolves `mac:` bindings from the platform, so drive the chord it will match.
const chord = (f: Fixture, bracket: "[" | "]") =>
  /Mac/.test(f.win.navigator.platform)
    ? `{Meta>}{Alt>}${bracket === "[" ? "[[" : "]"}{/Alt}{/Meta}`
    : `{Control>}{Shift>}${bracket === "[" ? "[[" : "]"}{/Shift}{/Control}`;

describe("collapse bars — keyboard path (real Chromium, production bundle)", () => {
  for (const c of CASES) {
    it(`editable ${c.name}: fold keys expand then collapse the block at the caret`, async () => {
      fixture = await productionPasteFixture(c.doc);
      const f = fixture;
      await f.select(c.doc.indexOf("line2"));
      expect(f.win.document.activeElement).toBe(f.view.contentDOM);
      expect(expanded(f, c.bar)).toBe("false");

      await userEvent.keyboard(chord(f, "]"));
      await expect.poll(() => expanded(f, c.bar)).toBe("true");
      await userEvent.keyboard(chord(f, "["));
      await expect.poll(() => expanded(f, c.bar)).toBe("false");
      expect(f.win.document.activeElement).toBe(f.view.contentDOM);
      expect(f.changes()).toBe(0);
    });

    it(`read-only ${c.name}: Tab reaches the bar; Enter expands and collapses, focus follows`, async () => {
      fixture = await productionPasteFixture(c.doc, "\n", false);
      const f = fixture;
      const line = [...f.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) =>
        l.textContent?.includes("line2")
      );
      // Read-only content is not a focus target: a click leaves focus on the page, with
      // the sequential-navigation starting point at the clicked line.
      await userEvent.click(line as HTMLElement);
      await userEvent.keyboard("{Tab}");
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar));

      await userEvent.keyboard("{Enter}");
      await expect.poll(() => expanded(f, c.bar)).toBe("true");
      // The "Show less" bar is a NEW widget; focus moved onto it, so the next key
      // reaches it without re-tabbing from the top of the page.
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar));
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => expanded(f, c.bar)).toBe("false");
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar));
      expect(f.changes()).toBe(0);
    });
  }

  it("editable: outside an expandable / collapsible block the fold keys still fold", async () => {
    const doc = `# H\n\n${CASES[0].doc}`;
    fixture = await productionPasteFixture(doc);
    const f = fixture;
    // Caret on the heading line: the collapse commands decline, so the key reaches
    // quollFoldKeymap's foldCode (Prec.high must not swallow it).
    // Folding "# H" hides the section body, the fence with it.
    const shown = () => f.view.contentDOM.textContent?.includes("line2") ?? false;
    await f.select(1);
    expect(shown()).toBe(true);
    await userEvent.keyboard(chord(f, "["));
    await expect.poll(shown).toBe(false);
    expect(f.win.document.querySelectorAll(".quoll-fenced-collapse-toggle").length).toBe(0);
  });
});
