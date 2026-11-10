import { expect, it } from "vitest";

import { productionPasteFixture } from "./helpers/production-paste-fixture.js";

it("fresh production assets are served without dist", async () => {
  for (const [extension, mime] of [
    ["js", "text/javascript"],
    ["css", "text/css"],
  ]) {
    const response = await fetch(`/__quoll-production/index.${extension}`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("Content-Type")).toContain(mime);
    expect((await response.text()).length).toBeGreaterThan(1000);
  }
});

it("production bundle posts seeded edit", async () => {
  const fixture = await productionPasteFixture("seed ");
  try {
    await fixture.select(5);
    fixture.paste({ "text/plain": "hello" });
    await fixture.posted("seed hello");
    expect(fixture.view.state.doc.toString()).toBe("seed hello");
    expect(fixture.changes()).toBe(1);
    expect(fixture.messages.filter((message) => message.type === "ready")).toHaveLength(1);
  } finally {
    fixture.dispose();
  }
});

it("production table and File insert exactly once", async () => {
  const fixture = await productionPasteFixture();
  try {
    await fixture.select(0);
    fixture.paste(
      {
        "text/plain": "wrong plain representation",
        "text/html": "<table><tr><th>A</th></tr><tr><td>B</td></tr></table>",
      },
      ["table.png"]
    );
    await expect.poll(() => fixture.requests().length).toBe(1);
    expect(fixture.changes()).toBe(0);
    expect(fixture.edits()).toHaveLength(0);
    expect(fixture.view.state.doc.toString()).toBe("");
    fixture.reply(fixture.requests()[0], "./assets/table.png");
    const expected = "| A |\n| --- |\n| B |\n![](./assets/table.png)\n";
    await fixture.posted(expected);
    expect(fixture.view.state.doc.toString()).toBe(expected);
    expect(fixture.changes()).toBe(1);
  } finally {
    fixture.dispose();
  }
});

it("production reverse replies preserve clipboard image order", async () => {
  const fixture = await productionPasteFixture();
  try {
    await fixture.select(0);
    fixture.paste({}, ["first.png", "second.png"]);
    await expect.poll(() => fixture.requests().length).toBe(2);
    // Identify slots by their captured bytes, independent of FileReader completion order.
    const first = fixture
      .requests()
      .find((request) => request.data === fixture.win.btoa("first.png"));
    const second = fixture
      .requests()
      .find((request) => request.data === fixture.win.btoa("second.png"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) {
      throw new Error("Missing captured file request");
    }
    fixture.reply(second, "./assets/second.png");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(fixture.changes()).toBe(0);
    expect(fixture.edits()).toHaveLength(0);
    fixture.reply(first, "./assets/first.png");
    const expected = "![](./assets/first.png)\n![](./assets/second.png)\n";
    await fixture.posted(expected);
    expect(fixture.view.state.doc.toString()).toBe(expected);
    expect(fixture.changes()).toBe(1);
  } finally {
    fixture.dispose();
  }
});

it("production caption survives File rejection", async () => {
  const fixture = await productionPasteFixture();
  try {
    await fixture.select(0);
    fixture.paste({ "text/html": "<p>HTML caption</p>" }, ["rejected.png"]);
    await expect.poll(() => fixture.requests().length).toBe(1);
    expect(fixture.changes()).toBe(0);
    fixture.reply(fixture.requests()[0], null);
    await fixture.posted("HTML caption\n");
    expect(fixture.view.state.doc.toString()).toBe("HTML caption\n");
    expect(fixture.changes()).toBe(1);
    expect(fixture.frame.contentDocument?.querySelector('[role="status"]')?.textContent).toContain(
      "Paste could not be completed in full."
    );
  } finally {
    fixture.dispose();
  }
});

it("production pending undo preserves redo", async () => {
  const fixture = await productionPasteFixture("base ");
  try {
    await fixture.select(5);
    await fixture.type("typed");
    await fixture.posted("base typed");
    // Keep the target outside the typing that Undo removes, so history cancellation is required.
    await fixture.select(0);
    fixture.paste({}, ["late.png"]);
    await expect.poll(() => fixture.requests().length).toBe(1);
    fixture.history();
    await fixture.posted("base ", 2);
    expect(fixture.view.state.doc.toString()).toBe("base ");
    fixture.reply(fixture.requests()[0], "./assets/late.png");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(fixture.view.state.doc.toString()).toBe("base ");
    expect(fixture.edits()).toHaveLength(2);
    fixture.history(true);
    await fixture.posted("base typed", 3);
    expect(fixture.view.state.doc.toString()).toBe("base typed");
    expect(fixture.changes()).toBe(3);
    expect(fixture.requests()).toHaveLength(1);
  } finally {
    fixture.dispose();
  }
});

it("production settlement preserves moved selection", async () => {
  const content = `top\n\n${Array.from({ length: 120 }, (_, index) => `line ${index}`).join("\n")}`;
  const fixture = await productionPasteFixture(content);
  try {
    await fixture.select(0);
    fixture.paste({ "text/plain": "caption" }, ["moved.png"]);
    await expect.poll(() => fixture.requests().length).toBe(1);
    const mac = /Mac/.test(fixture.win.navigator.platform);
    fixture.view.contentDOM.dispatchEvent(
      new fixture.win.KeyboardEvent("keydown", {
        key: "End",
        code: "End",
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      })
    );
    await expect.poll(() => fixture.view.state.selection.main.head).toBe(content.length);
    await expect.poll(() => fixture.view.scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(fixture.changes()).toBe(0);
    fixture.reply(fixture.requests()[0], "./assets/moved.png");
    const inserted = "caption\n![](./assets/moved.png)\n";
    await fixture.posted(inserted + content);
    expect(fixture.view.state.doc.toString()).toBe(inserted + content);
    expect(fixture.view.state.selection.main.anchor).toBe(inserted.length + content.length);
    expect(fixture.view.state.selection.main.head).toBe(inserted.length + content.length);
    expect(fixture.view.scrollDOM.scrollTop).toBeGreaterThan(100);
    expect(fixture.changes()).toBe(1);
  } finally {
    fixture.dispose();
  }
});

it("production CRLF paste agrees with posted edit", async () => {
  const fixture = await productionPasteFixture("head\r\ntail", "\r\n");
  try {
    await fixture.select(0);
    fixture.paste({ "text/plain": "one\r\ntwo" }, ["crlf.png"]);
    await expect.poll(() => fixture.requests().length).toBe(1);
    expect(fixture.changes()).toBe(0);
    fixture.reply(fixture.requests()[0], "./assets/crlf.png");
    const inserted = "one\ntwo\n![](./assets/crlf.png)\n";
    const expected = `${inserted}head\ntail`;
    await fixture.posted(expected.replace(/\n/g, "\r\n"));
    expect(fixture.view.state.doc.toString()).toBe(expected);
    expect(fixture.view.state.selection.main.anchor).toBe(inserted.length);
    expect(fixture.view.state.selection.main.head).toBe(inserted.length);
    expect(fixture.changes()).toBe(1);
  } finally {
    fixture.dispose();
  }
});

it("production readOnly settlement leaves document unchanged", async () => {
  const fixture = await productionPasteFixture("keep");
  try {
    await fixture.select(0, 4);
    fixture.paste({ "text/plain": "replacement" }, ["readonly.png"]);
    await expect.poll(() => fixture.requests().length).toBe(1);
    await fixture.readOnly();
    fixture.reply(fixture.requests()[0], "./assets/readonly.png");
    await expect
      .poll(() =>
        fixture.warnings.some(
          (args) =>
            String(args[0]).includes("written but not linked") &&
            JSON.stringify(args).includes("./assets/readonly.png")
        )
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(fixture.view.state.doc.toString()).toBe("keep");
    expect(fixture.view.state.selection.main.anchor).toBe(0);
    expect(fixture.view.state.selection.main.head).toBe(4);
    expect(fixture.changes()).toBe(0);
    expect(fixture.edits()).toHaveLength(0);
  } finally {
    fixture.dispose();
  }
});

it("production ordinary plain clipboard inserts once", async () => {
  const fixture = await productionPasteFixture("before old after");
  try {
    await fixture.select(7, 10);
    fixture.paste({ "text/plain": "ordinary\nplain" });
    const expected = "before ordinary\nplain after";
    await fixture.posted(expected);
    expect(fixture.view.state.doc.toString()).toBe(expected);
    expect(fixture.view.state.selection.main.head).toBe(7 + "ordinary\nplain".length);
    expect(fixture.changes()).toBe(1);
    expect(fixture.requests()).toHaveLength(0);
  } finally {
    fixture.dispose();
  }
});
