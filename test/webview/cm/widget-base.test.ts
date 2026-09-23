// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  containWidgetRender,
  QuollWidget,
  resetWidgetThrowLatchForTest,
} from "../../../src/webview/cm/widget-base.js";

class Throwing extends QuollWidget {
  readonly widgetName = "Throwing";
  protected render(): HTMLElement {
    throw new Error("render exploded");
  }
  protected patchDOM(dom: HTMLElement, _v: EditorView, _p: Throwing, _s: AbortSignal): boolean {
    dom.appendChild(document.createElement("i")); // mutate, THEN fail
    throw new Error("patch exploded");
  }
  protected dispose(): void {
    throw new Error("dispose exploded");
  }
  protected sameAs(): boolean {
    throw new Error("sameAs exploded");
  }
}

class Working extends QuollWidget {
  readonly widgetName = "Working";
  clicks = 0;
  protected render(_view: EditorView, signal: AbortSignal): HTMLElement {
    const el = document.createElement("b");
    el.textContent = "ok";
    el.addEventListener(
      "click",
      () => {
        this.clicks += 1;
      },
      { signal }
    );
    return el;
  }
  protected sameAs(other: QuollWidget): boolean {
    return other instanceof Working;
  }
}

let view: EditorView;
beforeEach(() => {
  // ⚠️ The latch is module state; `vi.restoreAllMocks()` does not touch it, and
  // without this reset the first throwing test consumes the session's one log
  // and every later log assertion silently measures 0.
  resetWidgetThrowLatchForTest();
  view = new EditorView({ state: EditorState.create({ doc: "" }) });
});
afterEach(() => {
  view.destroy();
  vi.restoreAllMocks();
});

describe("QuollWidget", () => {
  it("a throwing render yields the inert placeholder, not a throw", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = new Throwing().toDOM(view);
    expect(dom.dataset.quollWidgetError).toBe("Throwing");
    expect(dom.textContent).toBe("⚠");
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("the log is once per (hook, widget), not once per build and not once per session", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new Throwing();
    t.toDOM(view);
    t.toDOM(view);
    expect(err).toHaveBeenCalledTimes(1); // same hook, same widget: latched
    t.destroy(document.createElement("div"));
    expect(err).toHaveBeenCalledTimes(2); // a DIFFERENT hook still gets its line
  });

  it("the log carries no property of the thrown value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    new Throwing().toDOM(view);
    const payload = err.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ widget: "Throwing", hook: "render", errKind: "object" });
  });

  it("a thrown value whose accessors themselves throw cannot escape the guard", () => {
    // ⚠️ console.error is NOT stubbed here. Stubbing it is what makes this
    // regression class invisible: the real console reads `message` / `stack` to
    // format, so a hostile or buggy Error subclass could re-enter the very
    // failure the guard exists to contain. `cell-render.ts:492` reached the same
    // conclusion one layer down — read NO property of a value you did not throw.
    class Hostile extends Error {
      get message(): string {
        throw new Error("getter exploded");
      }
      get stack(): string {
        throw new Error("getter exploded");
      }
    }
    class HostileWidget extends QuollWidget {
      readonly widgetName = "HostileWidget";
      protected render(): HTMLElement {
        throw new Hostile();
      }
      protected sameAs(): boolean {
        return false;
      }
    }
    expect(() => new HostileWidget().toDOM(view)).not.toThrow();
  });

  it("a thrown Proxy whose getPrototypeOf trap throws cannot escape either", () => {
    // ⚠️ This is why the classifier is `typeof`, not `instanceof`: `instanceof`
    // runs this trap, from inside the catch.
    class ProxyThrower extends QuollWidget {
      readonly widgetName = "ProxyThrower";
      protected render(): HTMLElement {
        throw new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("trap exploded");
            },
          }
        );
      }
      protected sameAs(): boolean {
        return false;
      }
    }
    expect(() => new ProxyThrower().toDOM(view)).not.toThrow();
  });

  it("a throwing sameAs reports 'not equal' so CodeMirror rebuilds the tile", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // `compare` -> `eq` runs INSIDE the tile builder (view dist:2552 / :140), so
    // a throw here wedges the view exactly like a throwing render. `false` is the
    // conservative verdict: rebuild rather than reuse.
    expect(new Throwing().eq(new Throwing())).toBe(false);
  });

  it("a throwing patchDOM leaves NO half-patched DOM behind for another widget to reuse", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = document.createElement("div");
    dom.textContent = "old";
    const w = new Throwing();
    expect(w.updateDOM(dom, view, w)).toBe(false);
    // ⚠️ `false` alone is NOT enough: CodeMirror's `findWidget` (view dist:2539)
    // leaves the rejected candidate in the reuse cache, so a LATER widget in the
    // same builder run can adopt this element. Measured by Codex against a real
    // EditorView: expected ["B", "A"], got ["B", "HALF-PATCHED"]. So the guard
    // has to neutralise the element it could not finish patching.
    expect(dom.dataset.quollWidgetError).toBe("Throwing");
    expect(dom.textContent).toBe("⚠");
    expect(dom.querySelector("i")).toBeNull();
  });

  it("a throwing dispose does not escape destroy", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => new Throwing().destroy(document.createElement("div"))).not.toThrow();
  });

  it("containWidgetRender gives the fold callback the same fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = containWidgetRender("foldPlaceholder", () => {
      throw new Error("fold render exploded");
    });
    expect(dom.dataset.quollWidgetError).toBe("foldPlaceholder");
  });

  it("a render that throws AFTER binding listeners aborts them, not just the placeholder", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let orphanClicks = 0;
    let orphan: HTMLElement | null = null;
    // Half-built: the node is bound and then abandoned when render throws. It is
    // never returned, so it is NOT the element the placeholder registers — only
    // aborting the controller inside the catch can reach it. Measured without
    // that abort: a half-built picker's detached <select> still took a `change`
    // and rewrote the document.
    containWidgetRender("HalfBuilt", (signal) => {
      orphan = document.createElement("div");
      orphan.addEventListener(
        "click",
        () => {
          orphanClicks += 1;
        },
        { signal }
      );
      throw new Error("render exploded after binding");
    });
    (orphan as unknown as HTMLElement).click();
    expect(orphanClicks).toBe(0);
  });

  it("a healthy widget is untouched — no placeholder, no log", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dom = new Working().toDOM(view);
    expect(dom.tagName).toBe("B");
    expect(dom.textContent).toBe("ok");
    expect(dom.dataset.quollWidgetError).toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });

  it("a widget without patchDOM reports 'not patched' (CodeMirror's own default)", () => {
    const w = new Working();
    expect(w.updateDOM(document.createElement("div"), view, w)).toBe(false);
  });

  it("destroy removes every listener the widget bound during render", () => {
    const w = new Working();
    const dom = w.toDOM(view);
    dom.click();
    expect(w.clicks).toBe(1);
    w.destroy(dom);
    dom.click();
    // ⚠️ Still 1. This is the assertion that closes the last reuse route:
    // `compare`'s `this == other` shortcut (dist:140) can hand a poisoned
    // element back to the SAME widget instance without consulting `eq`, and a
    // surviving listener on it reaches the document (measured: a reused task
    // checkbox wrote `- [x] beta`). The signal makes that unreachable rather
    // than unlikely.
    expect(w.clicks).toBe(1);
  });

  it("a failed patch also aborts the element's listeners and makes it inert", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = new Working();
    const dom = owner.toDOM(view);
    dom.click();
    expect(owner.clicks).toBe(1);
    const breaker = new Throwing();
    // `prev` is the widget that built `dom` — CodeMirror passes `tile.widget`.
    expect(breaker.updateDOM(dom, view, owner as unknown as Throwing)).toBe(false);
    dom.click();
    expect(owner.clicks).toBe(1);
    expect(dom.inert).toBe(true);
  });
});
