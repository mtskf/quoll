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

// Two long blocks of one kind: which bar receives focus, and which block the caret command
// picks, are only observable when there is more than one candidate.
const TWO_CASES = [
  {
    name: "fenced code",
    doc: `\`\`\`\n${body(14, "a")}\n\`\`\`\n\nmid\n\n\`\`\`\n${body(14, "b")}\n\`\`\`\n\npara\n`,
    bar: "fenced",
  },
  {
    name: "blockquote",
    doc: `${body(14, "> a")}\n\nmid\n\n${body(14, "> b")}\n\npara\n`,
    bar: "blockquote",
  },
] as const;

/** The `i`-th of exactly `of` bars of this kind, in document order. */
const toggleOf = (f: Fixture, bar: string, i = 0, of = 1) => {
  const t = f.win.document.querySelectorAll<HTMLButtonElement>(`.quoll-${bar}-collapse-toggle`);
  expect(t.length).toBe(of);
  return t[i] as HTMLButtonElement;
};
const expanded = (f: Fixture, bar: string, i = 0, of = 1) =>
  toggleOf(f, bar, i, of).getAttribute("aria-expanded");
/** The drawn bar of this kind in `state` ("true" = Show less), or null when none is drawn. */
const barIn = (f: Fixture, bar: string, state: "true" | "false") =>
  f.win.document.querySelector<HTMLButtonElement>(
    `.quoll-${bar}-collapse-toggle[aria-expanded="${state}"]`
  );
/** The drawn `.cm-line` whose text contains `text`. */
const lineWith = (f: Fixture, text: string) =>
  [...f.view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find((l) =>
    l.textContent?.includes(text)
  ) as HTMLElement;
const expectInScrollport = (f: Fixture, el: HTMLElement) => {
  const box = el.getBoundingClientRect();
  const port = f.view.scrollDOM.getBoundingClientRect();
  expect(box.top).toBeGreaterThanOrEqual(port.top);
  expect(box.bottom).toBeLessThanOrEqual(port.bottom);
};

// CodeMirror resolves `mac:` bindings from the platform, so drive the chord it will match.
const chord = (f: Fixture, bracket: "[" | "]") => {
  if (/Mac/.test(f.win.navigator.platform)) {
    // userEvent.keyboard reads `[` as a key-descriptor opener; `[[` types a literal `[`.
    return `{Meta>}{Alt>}${bracket === "[" ? "[[" : "]"}{/Alt}{/Meta}`;
  }
  // With Shift held a real keyboard reports the shifted character (`{` / `}`), and
  // CodeMirror reaches `Ctrl-Shift-[` / `]` through the key code. Playwright does not
  // shift the character itself, so type it (`{{` is the literal `{`).
  return `{Control>}{Shift>}${bracket === "[" ? "{{" : "}"}{/Shift}{/Control}`;
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
      // Read-only content is not a focus target: a click leaves focus on the page, with
      // the sequential-navigation starting point at the clicked line.
      await userEvent.click(lineWith(f, "line2"));
      await userEvent.keyboard("{Tab}");
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar));

      await userEvent.keyboard("{Enter}");
      await expect.poll(() => expanded(f, c.bar)).toBe("true");
      // The "Show less" bar is a NEW widget, drawn (CodeMirror renders past the scrollport)
      // but below the 360px frame: focusing it would put the next Enter on a control the
      // reader cannot see, so focus goes to the scroller and the next Tab reaches the bar.
      expect(toggleOf(f, c.bar).getBoundingClientRect().top).toBeGreaterThan(
        f.view.scrollDOM.getBoundingClientRect().bottom
      );
      expect(f.win.document.activeElement).toBe(f.view.scrollDOM);
      await userEvent.keyboard("{Tab}");
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar));
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => expanded(f, c.bar)).toBe("false");
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar));
      expect(f.changes()).toBe(0);
    });
  }

  for (const c of TWO_CASES) {
    it(`editable ${c.name}, two blocks: the fold keys act on the block at the caret only`, async () => {
      fixture = await productionPasteFixture(c.doc);
      const f = fixture;
      await f.select(c.doc.indexOf("bline2"));
      await userEvent.keyboard(chord(f, "]"));
      await expect.poll(() => expanded(f, c.bar, 1, 2)).toBe("true");
      expect(expanded(f, c.bar, 0, 2)).toBe("false");
      await userEvent.keyboard(chord(f, "["));
      await expect.poll(() => expanded(f, c.bar, 1, 2)).toBe("false");
      expect(expanded(f, c.bar, 0, 2)).toBe("false");
      expect(f.changes()).toBe(0);
    });

    it(`read-only ${c.name}, two blocks: focus follows the toggled bar, not the first one`, async () => {
      fixture = await productionPasteFixture(c.doc, "\n", false);
      const f = fixture;
      await userEvent.click(lineWith(f, "aline2"));
      // Tab past the first bar (and anything else focusable) onto the second.
      for (let i = 0; i < 4 && f.win.document.activeElement !== toggleOf(f, c.bar, 1, 2); i++) {
        await userEvent.keyboard("{Tab}");
      }
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar, 1, 2));

      await userEvent.keyboard("{Enter}");
      await expect.poll(() => expanded(f, c.bar, 1, 2)).toBe("true");
      expect(expanded(f, c.bar, 0, 2)).toBe("false");
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar, 1, 2));
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => expanded(f, c.bar, 1, 2)).toBe("false");
      expect(f.win.document.activeElement).toBe(toggleOf(f, c.bar, 1, 2));
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
      const bar = (state: "true" | "false") => barIn(f, c.bar, state);
      await userEvent.click(lineWith(f, "row2x"));
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
      expectInScrollport(f, more as HTMLElement);
      expect(f.changes()).toBe(0);
    });
  }

  // A tall tail keeps the collapsed document taller than the scrollport, so the browser's
  // scroll clamp cannot bring the replacement "Show more" on screen by itself: whether it is
  // scrolled to is up to the toggle.
  const tail = Array.from({ length: 60 }, (_, i) => `tail${i + 1}`).join("\n\n");
  const tallTail = (c: (typeof LONG_CASES)[number]) => c.doc.replace("para\n", `${tail}\n`);
  const scrollToShowLess = async (f: Fixture, bar: string) => {
    const less = () => barIn(f, bar, "true");
    for (let i = 0; i < 80 && less() === null; i++) {
      f.view.scrollDOM.scrollTop += 300;
      await frames(f, 3);
    }
    expect(less()).not.toBeNull();
    (less() as HTMLElement).scrollIntoView({ block: "center" });
    await frames(f, 5);
    return less() as HTMLButtonElement;
  };

  // A focused "Show less" collapsed from the keyboard: the replacement's position at
  // dispatch time is pre-scroll, so focus must not wait on it being in the scrollport.
  for (const c of LONG_CASES) {
    it(`read-only long ${c.name} with a tall tail: a keyboard collapse focuses Show more and scrolls to it`, async () => {
      fixture = await productionPasteFixture(tallTail(c), "\n", false);
      const f = fixture;
      await userEvent.click(toggleOf(f, c.bar));
      const less = await scrollToShowLess(f, c.bar);
      less.focus({ preventScroll: true });
      expect(f.win.document.activeElement).toBe(less);

      await userEvent.keyboard("{Enter}");
      const more = barIn(f, c.bar, "false");
      expect(more).not.toBeNull();
      expect(f.win.document.activeElement).toBe(more);
      await frames(f, 5);
      expectInScrollport(f, more as HTMLElement);
      expect(f.changes()).toBe(0);
    });
  }

  // These clicks start with the toggle unfocused (mousedown never gives it focus), so a
  // collapse must neither scroll to the replacement "Show more" nor take focus.
  for (const c of LONG_CASES) {
    it(`read-only long ${c.name}: a mouse collapse neither scrolls to the bar nor takes focus`, async () => {
      fixture = await productionPasteFixture(tallTail(c), "\n", false);
      const f = fixture;
      const scroller = f.view.scrollDOM;
      const bar = (state: "true" | "false") => barIn(f, c.bar, state);
      await userEvent.click(bar("false") as HTMLElement);
      await userEvent.click(await scrollToShowLess(f, c.bar));
      await expect.poll(() => bar("true")).toBeNull();
      await frames(f, 5);
      // Not scrolled to: the replacement is undrawn, or at least above the scrollport.
      const more = bar("false");
      if (more !== null) {
        expect(more.getBoundingClientRect().bottom).toBeLessThan(
          scroller.getBoundingClientRect().top
        );
      }
      expect(f.win.document.activeElement).not.toBe(bar("false"));
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
