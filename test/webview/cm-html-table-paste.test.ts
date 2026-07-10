// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { validateMarkdownForWrite } from "../../src/markdown/validate-for-write.js";
import { htmlTablePaste, htmlTableToGfm } from "../../src/webview/cm/paste/index.js";

describe("htmlTableToGfm — structure", () => {
  it("converts a thead + tbody table to GFM", () => {
    const html =
      "<table><thead><tr><th>A</th><th>B</th></tr></thead>" +
      "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    expect(htmlTableToGfm(html)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("uses the first row as the header when there is no thead", () => {
    const html = "<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(htmlTableToGfm(html)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("pads ragged body rows to the widest row without truncating", () => {
    const html =
      "<table><tr><td>a</td><td>b</td></tr>" +
      "<tr><td>c</td></tr>" + // short
      "<tr><td>d</td><td>e</td><td>f</td></tr></table>"; // wide → sets width 3
    expect(htmlTableToGfm(html)).toBe(
      "| a | b |  |\n| --- | --- | --- |\n| c |  |  |\n| d | e | f |"
    );
  });

  it("returns null when there is no table", () => {
    expect(htmlTableToGfm("<p>hello</p>")).toBeNull();
    expect(htmlTableToGfm("")).toBeNull();
  });

  it("returns null for an empty table", () => {
    expect(htmlTableToGfm("<table></table>")).toBeNull();
  });

  it("does not throw on malformed HTML", () => {
    expect(() => htmlTableToGfm("<table><tr><td>a")).not.toThrow();
    expect(htmlTableToGfm("<table><tr><td>a")).toBe("| a |\n| --- |");
  });
});

describe("htmlTableToGfm — cell escaping", () => {
  it("escapes pipes and backslashes so cells round-trip literally", () => {
    expect(htmlTableToGfm("<table><tr><td>a|b</td><td>c</td></tr></table>")).toContain("| a\\|b |");
    expect(htmlTableToGfm("<table><tr><td>a\\b</td><td>c</td></tr></table>")).toContain(
      "| a\\\\b |"
    );
    // literal backslash-pipe → escaped backslash + escaped pipe
    expect(htmlTableToGfm("<table><tr><td>a\\|b</td><td>c</td></tr></table>")).toContain(
      "| a\\\\\\|b |"
    );
  });

  it("neutralises explicit link/code/emphasis syntax in cell text", () => {
    expect(htmlTableToGfm("<table><tr><td>[x](y)</td><td>c</td></tr></table>")).toContain(
      "\\[x\\](y)"
    );
    expect(htmlTableToGfm("<table><tr><td>`c`</td><td>d</td></tr></table>")).toContain("\\`c\\`");
    expect(htmlTableToGfm("<table><tr><td>*b*</td><td>d</td></tr></table>")).toContain("\\*b\\*");
  });

  it("escapes underscore, tilde and angle-bracket so emphasis/strike/HTML stay literal", () => {
    // _ (emphasis), ~ (GFM strikethrough), < (raw-HTML / autolink) must not
    // re-activate as live formatting when a cell round-trips as literal text.
    expect(htmlTableToGfm("<table><tr><td>_i_</td><td>c</td></tr></table>")).toContain("\\_i\\_");
    expect(htmlTableToGfm("<table><tr><td>~~s~~</td><td>c</td></tr></table>")).toContain(
      "\\~\\~s\\~\\~"
    );
    // `a<x>b`: DOMParser drops the unknown `<x>` element (no text), leaving `ab`
    // — so use a bare `<` that survives as text to assert the angle-bracket escape.
    expect(htmlTableToGfm("<table><tr><td>a &lt; b</td><td>c</td></tr></table>")).toContain("\\<");
  });

  it("leaves line-start-only constructs literal (not inline-active in a cell)", () => {
    const out = htmlTableToGfm("<table><tr><td># x</td><td>1.5</td><td>- y</td></tr></table>");
    expect(out).toContain("# x");
    expect(out).toContain("1.5");
    expect(out).toContain("- y");
    // deliberately NOT escaped
    expect(out).not.toContain("\\#");
    expect(out).not.toContain("1\\.5");
  });
});

describe("htmlTableToGfm — cell text extraction", () => {
  it("turns <br> and inner newlines into a single space", () => {
    expect(htmlTableToGfm("<table><tr><td>a<br>b</td><td>c</td></tr></table>")).toContain(
      "| a b |"
    );
    expect(htmlTableToGfm("<table><tr><td>a\n  b</td><td>c</td></tr></table>")).toContain(
      "| a b |"
    );
  });

  it("separates block-element boundaries so text does not glue", () => {
    expect(
      htmlTableToGfm("<table><tr><td><div>a</div><div>b</div></td><td>c</td></tr></table>")
    ).toContain("| a b |");
  });

  it("does not leak <script>/<style> text into a cell", () => {
    const out = htmlTableToGfm(
      "<table><tr><td><script>alert(1)</script>foo</td><td><style>.x{}</style>bar</td></tr></table>"
    );
    expect(out).toContain("| foo | bar |");
    expect(out).not.toContain("alert");
    expect(out).not.toContain(".x{");
  });

  it("excludes nested-table rows and cells", () => {
    const html =
      "<table><tr><th>H1</th><th>H2</th></tr>" +
      "<tr><td>a</td><td>b<table><tr><td>NESTED</td></tr></table></td></tr></table>";
    const out = htmlTableToGfm(html);
    // exactly 3 output lines: header, delimiter, one body row (nested row excluded)
    expect(out?.split("\n").length).toBe(3);
    expect(out).toBe("| H1 | H2 |\n| --- | --- |\n| a | b NESTED |");
  });
});

describe("htmlTableToGfm — mixed-content fragments", () => {
  it("returns null when prose precedes the table (defer, do not drop the prose)", () => {
    expect(htmlTableToGfm("<p>intro</p><table><tr><td>A</td><td>B</td></tr></table>")).toBeNull();
  });

  it("returns null when prose follows the table", () => {
    expect(htmlTableToGfm("<table><tr><td>A</td><td>B</td></tr></table><p>outro</p>")).toBeNull();
  });

  it("returns null when the fragment carries two top-level tables", () => {
    expect(
      htmlTableToGfm("<table><tr><td>A</td></tr></table><table><tr><td>B</td></tr></table>")
    ).toBeNull();
  });

  it("still converts a plain single table wrapped in <meta>/whitespace", () => {
    // The browser wraps a table copy in <meta>/<style>; those carry no prose
    // (no text node / SKIP_TAGS), so a normal single-table copy still converts.
    const html = "<meta charset='utf-8'>\n  <table><tr><td>A</td><td>B</td></tr></table>\n  ";
    expect(htmlTableToGfm(html)).toBe("| A | B |\n| --- | --- |");
  });
});

describe("htmlTableToGfm — colspan / rowspan spread", () => {
  it("expands colspan into empty cells keeping columns aligned", () => {
    const html =
      "<table><tr><td colspan='2'>X</td><td>Y</td></tr>" +
      "<tr><td>a</td><td>b</td><td>c</td></tr></table>";
    expect(htmlTableToGfm(html)).toBe("| X |  | Y |\n| --- | --- | --- |\n| a | b | c |");
  });

  it("spreads a rowspan with an empty placeholder so lower rows do not shift", () => {
    const html = "<table><tr><td>A</td><td rowspan='2'>B</td></tr>" + "<tr><td>C</td></tr></table>";
    // C must stay under A (col 0); an empty placeholder sits under B (col 1)
    expect(htmlTableToGfm(html)).toBe("| A | B |\n| --- | --- |\n| C |  |");
  });

  it("drains non-contiguous pending columns (empty gap between two rowspans)", () => {
    const html =
      "<table><tr><td rowspan='2'>A</td><td>B</td><td rowspan='2'>C</td></tr>" +
      "<tr><td>M</td></tr></table>";
    // M lands in the middle column; col 0 and col 2 are placeholders
    expect(htmlTableToGfm(html)).toBe("| A | B | C |\n| --- | --- | --- |\n|  | M |  |");
  });

  it("treats colspan=0 / rowspan=0 as 1 (no span-to-end)", () => {
    expect(htmlTableToGfm("<table><tr><td colspan='0'>X</td><td>Y</td></tr></table>")).toBe(
      "| X | Y |\n| --- | --- |"
    );
  });

  it("spreads a cell with both colspan and rowspan (2x2 merge block)", () => {
    // The most common merged-cell shape from spreadsheets. The 2x2 region is the
    // anchor + three empty cells; the next row's cell must land in column 2.
    const html =
      "<table><tr><td colspan='2' rowspan='2'>M</td><td>X</td></tr>" +
      "<tr><td>Y</td></tr>" +
      "<tr><td>a</td><td>b</td><td>c</td></tr></table>";
    expect(htmlTableToGfm(html)).toBe(
      "| M |  | X |\n| --- | --- | --- |\n|  |  | Y |\n| a | b | c |"
    );
  });

  it("degrades a colspan overrunning a pending column without crashing", () => {
    // Dirty HTML: a rowspan from row 0 and a colspan in row 1 overlap.
    const html =
      "<table><tr><td rowspan='2'>A</td><td>B</td></tr>" +
      "<tr><td colspan='2'>M</td></tr></table>";
    const out = htmlTableToGfm(html);
    expect(out).not.toBeNull();
    expect(out?.split("\n").length).toBe(3);
  });
});

describe("htmlTableToGfm — caps", () => {
  it("returns null for over-length input", () => {
    const huge = `<table><tr><td>${"x".repeat(2 * 1024 * 1024)}</td></tr></table>`;
    expect(htmlTableToGfm(huge)).toBeNull();
  });

  it("returns null when rectangular padding would exceed the cell cap", () => {
    // one 1000-col header row + 60 single-cell rows → 61 * 1000 = 61000 > 50000
    const wide = `<tr>${"<td>x</td>".repeat(1000)}</tr>`;
    const narrow = "<tr><td>y</td></tr>".repeat(60);
    expect(htmlTableToGfm(`<table>${wide}${narrow}</table>`)).toBeNull();
  });

  it("returns null when the row count exceeds the cap inside one tbody", () => {
    // 5001 > MAX_HTML_TABLE_ROWS (5000), all in a single browser-implicit tbody:
    // the running cap must fire INSIDE the section, not only per top-level child.
    const rows = "<tr><td>x</td></tr>".repeat(5001);
    expect(htmlTableToGfm(`<table><tbody>${rows}</tbody></table>`)).toBeNull();
  });

  it("returns null when a single row exceeds the column cap", () => {
    // 1001 > MAX_HTML_TABLE_COLS (1000): exercises the in-loop col cap + placed guard.
    const row = `<tr>${"<td>x</td>".repeat(1001)}</tr>`;
    expect(htmlTableToGfm(`<table>${row}</table>`)).toBeNull();
  });
});

describe("htmlTableToGfm — security", () => {
  it("drops a link href (only the visible text survives)", () => {
    const out = htmlTableToGfm(
      "<table><tr><td><a href='javascript:alert(1)'>click</a></td><td>ok</td></tr></table>"
    );
    expect(out).toContain("click");
    expect(out).not.toContain("javascript");
  });

  it("drops an image src/alt (cell is empty)", () => {
    const out = htmlTableToGfm(
      "<table><tr><td><img src='https://evil.test/x.png' alt='pic'></td><td>ok</td></tr></table>"
    );
    expect(out).toBe("|  | ok |\n| --- | --- |");
    expect(out).not.toContain("evil");
    expect(out).not.toContain("pic");
  });

  it("produces output the host write-gate accepts (never rejected)", () => {
    // A cell full of gate-adjacent characters: --- , pipes, a would-be link.
    const html =
      "<table><tr><td>---</td><td>a|b</td></tr>" +
      "<tr><td>[x](javascript:alert(1))</td><td>c</td></tr></table>";
    const gfm = htmlTableToGfm(html);
    expect(gfm).not.toBeNull();
    const result = validateMarkdownForWrite(`${gfm}\n`);
    expect(result.ok).toBe(true);
  });
});

// --- Handler ---

function mount(doc: string, canWrite = true) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.readOnly.of(!canWrite),
        htmlTablePaste({ canWrite: () => canWrite }),
      ],
    }),
  });
  return view;
}

function firePaste(view: EditorView, data: { html?: string; text?: string }): Event {
  const store = new Map<string, string>();
  if (data.html !== undefined) {
    store.set("text/html", data.html);
  }
  if (data.text !== undefined) {
    store.set("text/plain", data.text);
  }
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => store.get(type) ?? "" },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("htmlTablePaste — handler", () => {
  it("inserts a GFM table for an HTML-table paste and consumes the event", () => {
    const view = mount("");
    const event = firePaste(view, {
      html: "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toContain("| A | B |");
    expect(view.state.doc.toString()).toContain("| --- | --- |");
    view.destroy();
  });

  it("blank-line separates a table pasted mid-content", () => {
    const view = mount("hello");
    view.dispatch({ selection: { anchor: 5 } });
    firePaste(view, { html: "<table><tr><td>A</td><td>B</td></tr></table>" });
    expect(view.state.doc.toString()).toBe("hello\n\n| A | B |\n| --- | --- |\n");
    view.destroy();
  });

  it("blank-line separates a table pasted between existing text (non-empty after)", () => {
    // Caret in the MIDDLE: `after` = "world" (no leading newline) exercises the
    // blockSuffix `else → "\n\n"` branch, which the end-anchored case never hits.
    const view = mount("helloworld");
    view.dispatch({ selection: { anchor: 5 } });
    firePaste(view, { html: "<table><tr><td>A</td><td>B</td></tr></table>" });
    expect(view.state.doc.toString()).toBe("hello\n\n| A | B |\n| --- | --- |\n\nworld");
    view.destroy();
  });

  it("uses a single newline suffix when one blank line already follows (\\n branch)", () => {
    // `after` starts with a single "\n" → blockSuffix returns "\n" (not "\n\n").
    const view = mount("hello\nworld");
    view.dispatch({ selection: { anchor: 5 } }); // caret right before the "\n"
    firePaste(view, { html: "<table><tr><td>A</td><td>B</td></tr></table>" });
    expect(view.state.doc.toString()).toBe("hello\n\n| A | B |\n| --- | --- |\n\nworld");
    view.destroy();
  });

  it("defers a fragment with prose alongside a table (preserves the prose)", () => {
    const view = mount("");
    firePaste(view, {
      html: "<p>intro</p><table><tr><td>A</td><td>B</td></tr></table>",
      text: "intro\nA\tB",
    });
    // Not converted: no delimiter row is inserted; the plain-text path keeps prose.
    expect(view.state.doc.toString()).not.toContain("| --- |");
    view.destroy();
  });

  it("defers a non-table HTML paste (does not convert)", () => {
    const view = mount("");
    firePaste(view, { html: "<p>rich text</p>", text: "rich text" });
    expect(view.state.doc.toString()).not.toContain("---");
    view.destroy();
  });

  it("defers when there is no text/html flavour (no GFM table produced)", () => {
    const view = mount("");
    firePaste(view, { text: "plain" });
    // The handler stayed out (returned false); CM's own plain-text paste may run,
    // but no GFM table was produced.
    expect(view.state.doc.toString()).not.toContain("| --- |");
    view.destroy();
  });

  it("swallows a table paste in a read-only editor without inserting", () => {
    const view = mount("", false);
    const event = firePaste(view, {
      html: "<table><tr><td>A</td><td>B</td></tr></table>",
    });
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });
});
