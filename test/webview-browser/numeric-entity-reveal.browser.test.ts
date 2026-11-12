import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { NumericEntityWidget } from "../../src/webview/cm/decorations/numeric-entity-widget.js";
import { settled } from "./helpers/frames.js";
import { productionPasteFixture } from "./helpers/production-paste-fixture.js";

type Fixture = Awaited<ReturnType<typeof productionPasteFixture>>;
type Measurement = { widget: number; literal: number; wrapAtBuffer: boolean };
let spike: { wj: Measurement; letter: Measurement } | undefined;

function lines(element: HTMLElement): number {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  return new Set(rects.map((rect) => Math.round(rect.top))).size;
}

async function measure(source: string, replacement: string | null, width: number) {
  const host = document.createElement("div");
  host.style.cssText = `width:${width}px; font: 20px monospace;`;
  document.body.append(host);
  const extensions = [EditorView.lineWrapping];
  if (replacement !== null) {
    const from = source.indexOf("#");
    extensions.push(
      EditorView.decorations.of(
        Decoration.set([
          Decoration.replace({ widget: new NumericEntityWidget(replacement, "") }).range(
            from,
            from + 1
          ),
        ])
      )
    );
  }
  const view = new EditorView({
    state: EditorState.create({ doc: source, extensions }),
    parent: host,
  });
  try {
    await settled();
    const line = view.dom.querySelector<HTMLElement>(".cm-line");
    if (!line) {
      throw new Error("Missing line");
    }
    return lines(line);
  } finally {
    view.destroy();
    host.remove();
  }
}

async function runSpike() {
  let wj: Measurement = { widget: 0, literal: 0, wrapAtBuffer: false };
  let letter: Measurement = { widget: 0, literal: 0, wrapAtBuffer: false };
  let breakControl = false;
  for (const width of [30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100]) {
    const [ww, wl, lw, ll, noJoiner] = await Promise.all([
      measure("漢#字", "\u2060", width),
      measure("漢\u2060字", null, width),
      measure("漢#字", "a", width),
      measure("漢a字", null, width),
      measure("漢字", null, width),
    ]);
    breakControl ||= noJoiner > 1;
    if (ww > wl || !wj.widget) {
      wj = { widget: ww, literal: wl, wrapAtBuffer: ww > wl };
    }
    if (lw > ll || !letter.widget) {
      letter = { widget: lw, literal: ll, wrapAtBuffer: lw > ll };
    }
  }
  expect(breakControl).toBe(true);
  console.log(
    `wj.wrapAtBuffer: ${wj.wrapAtBuffer} widget lines: ${wj.widget} literal lines: ${wj.literal}`
  );
  console.log(
    `letter.wrapAtBuffer: ${letter.wrapAtBuffer} widget lines: ${letter.widget} literal lines: ${letter.literal}`
  );
  return { wj, letter };
}

function errorObserver(fixture: Fixture) {
  const errors: unknown[][] = [];
  const spy = vi
    .spyOn(fixture.win.console, "error")
    .mockImplementation((...args) => errors.push(args));
  return { errors, restore: () => spy.mockRestore() };
}

async function arrow(fixture: Fixture, key: "ArrowLeft" | "ArrowRight", expected: number) {
  await userEvent.keyboard(key === "ArrowLeft" ? "{ArrowLeft}" : "{ArrowRight}");
  await expect.poll(() => fixture.view.state.selection.main.head).toBe(expected);
}

it("measures inline widget buffer wrapping", async () => {
  spike = await runSpike();
});

it("word joiner displays invisibly and reveals from either keyboard boundary", async () => {
  for (const source of [
    "**a**&#8288;*b*",
    "&#8288;x",
    "x&#8288;",
    "x&#8288;&#8288;y",
    "[x](url)&#8288;**y**",
  ]) {
    const fixture = await productionPasteFixture(source);
    const observer = errorObserver(fixture);
    try {
      const from = source.indexOf("&#8288;");
      const to = from + 7;
      await fixture.select(source.length === to ? 0 : source.length);
      await settled();
      const widget = fixture.view.dom.querySelector<HTMLElement>(".quoll-numeric-entity");
      expect(widget?.textContent).toBe("\u2060");
      expect(widget?.getBoundingClientRect().width).toBeLessThan(1);
      await fixture.select(from);
      for (let pos = from + 1; pos <= to; pos++) {
        await arrow(fixture, "ArrowRight", pos);
      }
      for (let pos = to - 1; pos >= from; pos--) {
        await arrow(fixture, "ArrowLeft", pos);
      }
      expect(fixture.view.state.doc.toString()).toBe(source);
      fixture.view.scrollDOM.scrollTop = fixture.view.scrollDOM.scrollHeight;
      await settled();
      expect(observer.errors).toEqual([]);
    } finally {
      observer.restore();
      fixture.dispose();
    }
  }
  const fixture = await productionPasteFixture("plain\n\n**&#97;** *&#98;*");
  const observer = errorObserver(fixture);
  try {
    for (const [raw, neighbour] of [
      ["&#97;", "**"],
      ["&#98;", "*"],
    ]) {
      const start = fixture.view.state.doc.toString().indexOf(raw);
      fixture.view.dispatch({ selection: { anchor: start + 2 } });
      await settled();
      const reveal = [
        ...fixture.view.dom.querySelectorAll<HTMLElement>(".quoll-syntax-reveal"),
      ].find((el) => el.textContent === raw);
      expect(reveal).toBeDefined();
      const marker = [
        ...fixture.view.dom.querySelectorAll<HTMLElement>(".quoll-syntax-reveal"),
      ].find((el) => el.textContent === neighbour);
      expect(marker).toBeDefined();
      if (!reveal || !marker) {
        throw new Error("Missing emphasized reveal");
      }
      const actual = fixture.win.getComputedStyle(reveal);
      const reference = fixture.win.getComputedStyle(marker);
      expect(actual.fontWeight).toBe(reference.fontWeight);
      expect(actual.fontStyle).toBe(reference.fontStyle);
    }
    fixture.view.scrollDOM.scrollTop = fixture.view.scrollDOM.scrollHeight;
    await settled();
    expect(observer.errors).toEqual([]);
  } finally {
    observer.restore();
    fixture.dispose();
  }
});

it("clicking a decoded character reveals its exact source", async () => {
  const fixture = await productionPasteFixture("before &#97; after");
  try {
    await fixture.select(0);
    const widget = fixture.view.dom.querySelector<HTMLElement>(".quoll-numeric-entity");
    expect(widget?.textContent).toBe("a");
    if (!widget) {
      throw new Error("Missing entity widget");
    }
    // The fixture lives in an iframe: a trusted click is aimed at the frame
    // element, at the widget's frame-local centre.
    const rect = widget.getBoundingClientRect();
    await userEvent.click(fixture.frame, {
      position: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    });
    await expect
      .poll(() => fixture.view.dom.querySelector(".quoll-syntax-reveal")?.textContent)
      .toBe("&#97;");
    expect(fixture.view.state.selection.main.head).toBeGreaterThanOrEqual(7);
    expect(fixture.view.state.selection.main.head).toBeLessThanOrEqual(12);
    expect(fixture.changes()).toBe(0);
  } finally {
    fixture.dispose();
  }
});

it("decoded entities match literal-character width and word-joiner wrapping", async () => {
  const results = spike ?? (await runSpike());
  for (const [raw, literal] of [
    ["&#97;", "a"],
    ["&#8288;", "\u2060"],
  ]) {
    const entity = await productionPasteFixture(`x ${raw} y`);
    const control = await productionPasteFixture(`x ${literal} y`);
    try {
      await entity.select(0);
      await control.select(0);
      await settled();
      const widget = entity.view.dom.querySelector<HTMLElement>(".quoll-numeric-entity");
      if (!widget) {
        throw new Error("Missing entity widget");
      }
      const range = control.win.document.createRange();
      const pos = control.view.domAtPos(2);
      const end = control.view.domAtPos(3);
      range.setStart(pos.node, pos.offset);
      range.setEnd(end.node, end.offset);
      expect(
        Math.abs(widget.getBoundingClientRect().width - range.getBoundingClientRect().width)
      ).toBeLessThan(1);
      if (literal === "\u2060") {
        expect(widget.getBoundingClientRect().width).toBeLessThan(1);
      }
    } finally {
      entity.dispose();
      control.dispose();
    }
  }
  // The widget must not add a wrap opportunity the literal lacks.
  expect(results.wj.wrapAtBuffer).toBe(false);
  expect(results.letter.wrapAtBuffer).toBe(false);
  expect(results.wj.widget).toBe(results.wj.literal);
  expect(results.letter.widget).toBe(results.letter.literal);
});

it("repair fallback displays its letter and selection-only reveal sends no edit", async () => {
  for (const [html, expected] of [
    ["<b>.</b>a", "**.**&#97;"],
    ["<b><code>x</code></b>a", "**`x`**&#97;"],
  ]) {
    const fixture = await productionPasteFixture();
    const observer = errorObserver(fixture);
    try {
      await fixture.select(0);
      fixture.paste({ "text/html": html });
      await expect.poll(() => fixture.view.state.doc.toString()).toContain("&#97;");
      const source = fixture.view.state.doc.toString();
      expect(source.trim()).toBe(expected);
      await fixture.posted(source);
      const changes = fixture.changes();
      const edits = fixture.edits().length;
      await fixture.select(0);
      await settled();
      expect(
        fixture.view.dom.querySelector<HTMLElement>(".quoll-numeric-entity")?.textContent
      ).toBe("a");
      const from = source.indexOf("&#97;");
      fixture.view.dispatch({ selection: { anchor: from + 2 } });
      await settled();
      expect(
        [...fixture.view.dom.querySelectorAll(".quoll-syntax-reveal")].some(
          (el) => el.textContent === "&#97;"
        )
      ).toBe(true);
      await fixture.select(0);
      await settled();
      expect(fixture.changes()).toBe(changes);
      expect(fixture.edits()).toHaveLength(edits);
      fixture.view.dispatch({ selection: { anchor: from + 2 } });
      await settled();
      await fixture.type("x");
      await expect.poll(() => fixture.view.state.doc.toString()).not.toBe(source);
      fixture.history();
      await expect.poll(() => fixture.view.state.doc.toString()).toBe(source);
      await settled();
      expect(observer.errors).toEqual([]);
    } finally {
      observer.restore();
      fixture.dispose();
    }
  }
});

it("pasted balanced regions conceal and reveal exactly their separators", async () => {
  for (const [html, expected] of [
    ["<b>a<i>b</i></b><i>c</i>", "**a**&#8288;***b***&#8288;*c*"],
    ["<i>a<b>b</b></i><b>c</b>", "*a*&#8288;***b***&#8288;**c**"],
    ["<b><i>a</i>a<i>a</i></b>", "***a***&#8288;**a**&#8288;***a***"],
    ['<a href="u"><b>a<i>b</i></b><i>c</i></a>', "[**a**&#8288;***b***&#8288;*c*](u)"],
  ]) {
    const fixture = await productionPasteFixture();
    const observer = errorObserver(fixture);
    try {
      await fixture.select(0);
      fixture.paste({ "text/html": html });
      await expect.poll(() => fixture.view.state.doc.toString().trim()).toBe(expected);
      const source = fixture.view.state.doc.toString();
      await fixture.posted(source);
      const offsets = [...source.matchAll(/&#8288;/g)].map((match) => match.index);
      expect(offsets).toEqual(
        [...expected.matchAll(/&#8288;/g)].map((match) => match.index + source.indexOf(expected))
      );
      // The content characters retain their source styles in the rendered editor.
      const letters = [...expected.matchAll(/[abc]/g)].filter(
        (match) => !expected.slice(0, match.index).endsWith("&#")
      );
      let styles: boolean[][];
      if (html.startsWith("<i>")) {
        styles = [
          [false, true],
          [true, true],
          [true, false],
        ];
      } else if (html.startsWith("<b><i>")) {
        styles = [
          [true, true],
          [true, false],
          [true, true],
        ];
      } else {
        styles = [
          [true, false],
          [true, true],
          [false, true],
        ];
      }
      for (let i = 0; i < letters.length; i++) {
        const pos = source.indexOf(expected) + letters[i].index;
        const dom = fixture.view.domAtPos(pos);
        const element =
          dom.node.nodeType === Node.ELEMENT_NODE ? (dom.node as Element) : dom.node.parentElement;
        expect(element).not.toBeNull();
        const computed = fixture.win.getComputedStyle(element as Element);
        expect(Number.parseInt(computed.fontWeight, 10) >= 600).toBe(styles[i][0]);
        expect(computed.fontStyle === "italic").toBe(styles[i][1]);
      }
      const changes = fixture.changes();
      const edits = fixture.edits().length;
      await fixture.select(source.length);
      await settled();
      const widgets = [...fixture.view.dom.querySelectorAll<HTMLElement>(".quoll-numeric-entity")];
      expect(widgets).toHaveLength(2);
      expect(fixture.view.dom.textContent).not.toContain("&#8288;");
      for (const widget of widgets) {
        expect(widget.textContent).toBe("\u2060");
        expect(widget.getBoundingClientRect().width).toBeLessThan(1);
      }
      for (const from of offsets) {
        fixture.view.dispatch({ selection: { anchor: from + 2 } });
        await settled();
        expect(
          [...fixture.view.dom.querySelectorAll(".quoll-syntax-reveal")].some(
            (el) => el.textContent === "&#8288;"
          )
        ).toBe(true);
        await fixture.select(source.length);
        await settled();
      }
      expect(fixture.view.state.doc.toString()).toBe(source);
      expect(fixture.changes()).toBe(changes);
      expect(fixture.edits()).toHaveLength(edits);
      expect(observer.errors).toEqual([]);
    } finally {
      observer.restore();
      fixture.dispose();
    }
  }
});
