// @vitest-environment happy-dom
// What a click does to a link the cell already rendered. The subject is the
// guard attached at render time, not the URL that got past the gate, so a row
// here asserts `defaultPrevented` and never markup.
// The rule, in one line: nothing inside a table-cell widget navigates on its
// own. A plain click belongs to the widget's caret-dispatch path, and the ONE
// escape hatch is Cmd/Ctrl+left-click on an absolute href, which falls through
// to the widget root handler and the host's open-external gate. Every other
// gesture — modifier-click on a relative or fragment href, `auxclick` from ANY
// non-primary button — is preventDefault'd, because each is a way to open a URL
// that would skip that gate. `contextmenu` is deliberately NOT suppressed
// (keyboard-invoked menus, a11y); that is safe only because an href the host
// would reject never became a live anchor at all, which is the cap pinned in
// cm-table-cell-render-urls.test.ts.
// The two tooltip rows are the directory's only assertions on `a.title` — the
// reason helpers/cell-render-fixtures.ts can strip it everywhere else.
import { describe, expect, it } from "vitest";

import { renderCellInline } from "../../../src/webview/cm/table/cell-render.js";

describe("renderCellInline — click routing on rendered links", () => {
  // C6b smoke #5 — plain click on a widget-internal link must NOT navigate to
  // the browser (that bypasses caret-reveal and locks the user out of editing
  // the link source). Modifier-click is the documented escape hatch matching
  // VS Code Markdown preview / Go-to-Definition convention.
  it("inline-link plain click is preventDefault'd (so the widget's caret-dispatch path takes over)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("inline-link Cmd/Ctrl-click falls through to default navigation (falls through to the widget root handler, which routes through the host open-external gate)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  // `isAllowedUrl` returns true for any schemeless string
  // (relative paths / fragments fall through to the "safe" branch), so
  // `./doc.md` and `#section` ship as live <a href>. Browser behaviour
  // for modifier-click on a relative href inside the VS Code webview
  // iframe is undefined. Pin modifier-click to preventDefault for
  // non-absolute hrefs so the user lands on the widget's caret-dispatch
  // path instead.
  it("relative-URL modifier-click is preventDefault'd (no undefined webview navigation)", () => {
    const [a] = renderCellInline("[local](./doc.md)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("fragment-URL modifier-click is preventDefault'd", () => {
    const [a] = renderCellInline("[section](#intro)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  // Pin the positive case so the absolute-scheme allowlist doesn't tighten
  // too far in a future refactor — mailto: must keep the external escape
  // hatch alongside https / http. Iterate both modifiers so a regression
  // that tightens the guard to `metaKey only` (or `ctrlKey only`) trips.
  it("mailto: modifier-click falls through to default navigation (falls through to the widget root handler, which routes through the host open-external gate)", () => {
    const [a] = renderCellInline("[mail](mailto:a@b.test)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  // Button-1 (middle-click) rides `auxclick` + the browser's native "open in
  // new tab" default — it does NOT fire `click` (per the UI Events spec, `click`
  // is primary-button-only), so the click-only guard never runs and the open
  // would skip the host `open-external` re-validation + MAX_HREF_LENGTH cap.
  // Middle-click-to-open is not a supported gesture (the vetted escape hatch is
  // Cmd/Ctrl+left-click), so every `auxclick` — even on an otherwise-openable
  // absolute href — must preventDefault.
  it("absolute-href middle-click (auxclick) is preventDefault'd (closes the open-external choke-point bypass)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("middle-click (auxclick) with a modifier is also preventDefault'd (aux buttons have no escape hatch)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
        ...modifier,
      });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  // The guard is intentionally button-agnostic — `auxclick` fires for any
  // non-primary button (back/forward too), so a future narrowing to
  // `event.button === 1` would silently reopen it for those. Pin a non-middle
  // aux button (4 = forward) so such a narrowing trips.
  it("non-middle auxclick (side button) is also preventDefault'd (button-agnostic guard)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 4 });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("autolink middle-click (auxclick) is preventDefault'd (same gate as inline links)", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("autolink plain click is preventDefault'd (same gate as inline links)", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not attach a contextmenu handler on a live link (keyboard-invoked menu / Shift+F10 still works)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not attach a contextmenu handler on a live autolink", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  // Autolink positive case — parallel to the inline-link Cmd/Ctrl test above.
  // Pins the autolink branch directly so a refactor that drops `attachLinkClickGuard`
  // from the autolink path trips here.
  it("autolink Cmd/Ctrl-click falls through to default navigation (absolute scheme — external open)", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("emits a discoverability tooltip on links (mentions the modifier key)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    expect(a.title).toMatch(/(Cmd|Ctrl)\+click to open/);
  });

  // Parallel pin for autolinks — the existing snapshot tests strip
  // `title="…"` before comparing (platform-dependent), so a regression
  // that forgot to attach the tooltip to autolinks would slip through.
  it("emits a discoverability tooltip on autolinks (mentions the modifier key)", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    expect(a.title).toMatch(/(Cmd|Ctrl)\+click to open/);
  });
});
