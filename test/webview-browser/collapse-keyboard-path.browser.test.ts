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
const rows = Array.from({ length: 300 }, (_, i) => `row${i + 1}x`);
const LONG_CASES = [
  { name: "fenced code", doc: `\`\`\`\n${rows.join("\n")}\n\`\`\`\n\npara\n`, bar: "fenced" },
  {
    name: "blockquote",
    doc: `${rows.map((r) => `> ${r}`).join("\n")}\n\npara\n`,
    bar: "blockquote",
  },
] as const;

const frames = (f: Fixture, n: number) =>
  new Promise<void>((resolve) => {
    let left = n;
    const tick = () => (--left <= 0 ? resolve() : f.win.requestAnimationFrame(tick));
    f.win.requestAnimationFrame(tick);
  });

const toggleOf = (f: Fixture, bar: string) => {
  const t = f.win.document.querySelectorAll<HTMLButtonElement>(`.quoll-${bar}-collapse-toggle`);
  expect(t.length).toBe(1);
  return t[0] as HTMLButtonElement;
};
const expanded = (f: Fixture, bar: string) => toggleOf(f, bar).getAttribute("aria-expanded");

// CodeMirror resolves `mac:` bindings from the platform, so drive the chord it will match.
const chord = (f: Fixture, bracket: "[" | "]") => {
  // userEvent.keyboard reads `[` as a key-descriptor opener; `[[` types a literal `[`.
  const key = bracket === "[" ? "[[" : "]";
  return /Mac/.test(f.win.navigator.platform)
    ? `{Meta>}{Alt>}${key}{/Alt}{/Meta}`
    : `{Control>}{Shift>}${key}{/Shift}{/Control}`;
};

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

  // A block far taller than the 360px frame: its "Show less" sits beyond CodeMirror's drawn
  // viewport after an expand, and its "Show more" far above it after a collapse — neither
  // replacement bar exists in the DOM unless the toggle makes it so.
  for (const c of LONG_CASES) {
    it(`read-only long ${c.name}: focus never drops to <body>, so the keys keep working`, async () => {
      fixture = await productionPasteFixture(c.doc, "\n", false);
      const f = fixture;
      const scroller = f.view.scrollDOM;
      const active = () => f.win.document.activeElement;
      const bar = (state: "true" | "false") =>
        f.win.document.querySelector<HTMLButtonElement>(
          `.quoll-${c.bar}-collapse-toggle[aria-expanded="${state}"]`
        );
      const line = [...f.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) =>
        l.textContent?.includes("row2x")
      );
      await userEvent.click(line as HTMLElement);
      await userEvent.keyboard("{Tab}");
      expect(active()).toBe(bar("false"));

      // Expand: the reader keeps their place, and focus stays inside the editor.
      const top = scroller.scrollTop;
      await userEvent.keyboard("{Enter}");
      expect(bar("false")).toBeNull();
      expect(bar("true")).toBeNull(); // not drawn: the fallback is what is under test
      expect(active()).toBe(scroller);
      await frames(f, 5);
      expect(scroller.scrollTop).toBe(top);
      await userEvent.keyboard("{PageDown}");
      await expect.poll(() => scroller.scrollTop).toBeGreaterThan(top);

      // Read on to the end of the block, then Tab onto "Show less".
      for (let i = 0; i < 80 && bar("true") === null; i++) {
        await userEvent.keyboard("{PageDown}");
        await frames(f, 3);
      }
      await userEvent.keyboard("{Tab}");
      expect(active()).toBe(bar("true"));

      // Collapse: the replacement "Show more" is drawn by the toggle's own dispatch and
      // takes focus at once; once measured, it is on screen.
      await userEvent.keyboard("{Enter}");
      const more = bar("false");
      expect(more).not.toBeNull();
      expect(active()).toBe(more);
      await frames(f, 5);
      const box = (more as HTMLElement).getBoundingClientRect();
      const port = scroller.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(port.top);
      expect(box.bottom).toBeLessThanOrEqual(port.bottom);
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

  // A folded section that ENDS with a long block leaves the caret allowed at the fold's
  // `to`, i.e. at the block's end — inside the block's extent, yet the block's bar is folded
  // away. The fold keys must act on the fold there, as if the block were short.
  for (const c of CASES) {
    const block = c.doc.slice(0, c.doc.indexOf("\n\npara"));
    const doc = `# H\n\n${block}\n\n# H2\n\ntail\n`;
    const blockEnd = doc.indexOf(block) + block.length;
    const shown = (f: Fixture) => f.view.contentDOM.textContent?.includes("line2") ?? false;
    const foldSection = async () => {
      fixture = await productionPasteFixture(doc);
      const f = fixture;
      await f.select(1);
      await userEvent.keyboard(chord(f, "["));
      await expect.poll(() => shown(f)).toBe(false);
      f.view.dispatch({ selection: { anchor: blockEnd } });
      f.view.contentDOM.focus();
      await frames(f, 3);
      expect(shown(f)).toBe(false);
      return f;
    };

    it(`editable ${c.name} in a folded section: the fold key leaves the section folded`, async () => {
      const f = await foldSection();
      await userEvent.keyboard(chord(f, "["));
      await frames(f, 5);
      expect(shown(f)).toBe(false);
      expect(f.view.state.selection.main.head).toBe(blockEnd);
    });

    it(`editable ${c.name} in a folded section: the unfold key opens the section`, async () => {
      const f = await foldSection();
      await userEvent.keyboard(chord(f, "]"));
      await expect.poll(() => shown(f)).toBe(true);
    });
  }
});
