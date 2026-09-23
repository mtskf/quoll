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

/** The minimal HEALTHY patcher. Its only job is to be the other side of the
 *  containment's refusals: every `false` this file pins would be indistinguishable
 *  from "there is nothing to patch with" without a widget that demonstrably DOES
 *  patch when nothing is wrong. Each test below establishes that baseline first. */
class Patching extends QuollWidget {
  readonly widgetName = "Patching";
  patches = 0;
  protected render(): HTMLElement {
    const el = document.createElement("b");
    el.textContent = "patched:0";
    return el;
  }
  protected sameAs(other: QuollWidget): boolean {
    return other instanceof Patching;
  }
  protected patchDOM(dom: HTMLElement): boolean {
    this.patches += 1;
    dom.textContent = `patched:${this.patches}`;
    return true;
  }
}

/** A healthy patcher that binds a listener from the PATCH path — the case
 *  `scopeOf` exists for. `render` deliberately binds nothing, so the only
 *  controller in play is the one the patch had to mint. */
class Rebinder extends QuollWidget {
  readonly widgetName = "Rebinder";
  clicks = 0;
  protected render(): HTMLElement {
    return document.createElement("b");
  }
  protected sameAs(other: QuollWidget): boolean {
    return other instanceof Rebinder;
  }
  protected patchDOM(dom: HTMLElement, _v: EditorView, _p: Rebinder, signal: AbortSignal): boolean {
    dom.addEventListener(
      "click",
      () => {
        this.clicks += 1;
      },
      { signal }
    );
    return true;
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
    // failure the guard exists to contain. `renderCellSafely`'s catch in
    // `cm/table/cell-render.ts` — the "anything finer costs a breakpoint"
    // console.error — reached the same conclusion one layer down: read NO
    // property of a value you did not throw. (Named by symbol, not by line: the
    // bare `:492` this comment used to carry had already rotted onto the
    // `return {` of a different function.)
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
    // ⚠️ The element carries ATTRIBUTES, and that is load-bearing. Before this,
    // both elements this file handed to `updateDOM` were attribute-free, so
    // `makePlaceholder`'s strip loop had nothing to strip and every assertion
    // about it was vacuous — measured: the loop could be made a no-op with all
    // 3505 webview tests still green.
    const dom = document.createElement("span");
    dom.setAttribute("role", "checkbox");
    dom.setAttribute("aria-checked", "true");
    dom.tabIndex = 0;
    dom.textContent = "old";
    const w = new Throwing();
    expect(w.updateDOM(dom, view, w)).toBe(false);
    // ⚠️ `false` alone is NOT enough: CodeMirror's `findWidget` (view dist:2540)
    // leaves the rejected candidate in the reuse cache — its pass-1 arm neither
    // splices the tile out (`:2554`) nor marks it reused (`:2558`) when
    // `updateDOM` declines — so a LATER widget in the same builder run can adopt
    // this element. Measured by Codex against a real EditorView: expected
    // ["B", "A"], got ["B", "HALF-PATCHED"]. So the guard has to neutralise the
    // element it could not finish patching.
    expect(dom.dataset.quollWidgetError).toBe("Throwing");
    expect(dom.textContent).toBe("⚠");
    expect(dom.querySelector("i")).toBeNull();
    // A neutralised element must stop describing itself as the thing it failed
    // to be: devtools and assistive tech both read these, and `inert` alone
    // leaves the labels in place.
    expect(dom.getAttribute("role")).toBeNull();
    expect(dom.getAttribute("aria-checked")).toBeNull();
    expect(dom.hasAttribute("tabindex")).toBe(false);
    // …but `contenteditable` must come BACK. CodeMirror stamps it outside
    // `toDOM` (`WidgetTile.of` `:2144`, the stamp itself at view dist:2148) and
    // only when the tile has no dom yet (`if (!dom)`, `:2145`), so on this path
    // — element neutralised in place, then re-adoptable
    // through `compare`'s `this == other` shortcut (`:140`) — nobody else will
    // put it back. The strip above is what takes it off.
    expect(dom.getAttribute("contenteditable")).toBe("false");
    // Stamped AFTER the strip, or the strip would remove the stamp too.
    expect(dom.dataset.quollWidgetError).toBe("Throwing");
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

  // ── The taint (`tainted.add(prev)`), pinned at both of its readers ──────────
  //
  // ⚠️ Why here and not in cm-widget-containment.test.ts: that file's system-level
  // case asserts the CONSEQUENCE of the taint (no placeholder survives a failed
  // table patch, because the tile is dropped and redrawn). Measured: that
  // assertion is green with `tainted.add(prev)` deleted, because `destroyDropped`
  // redraws the position either way. The taint has exactly two readers — `eq` and
  // `updateDOM`'s `tainted.has(prev)` arm — and each needs its own observation.

  it("a widget whose patch threw never compares equal again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const victim = new Patching();
    const dom = victim.toDOM(view);
    expect(victim.eq(new Patching())).toBe(true); // baseline: it IS the same widget
    expect(new Throwing().updateDOM(dom, view, victim as unknown as Throwing)).toBe(false);
    // `eq` short-circuits on the taint before `sameAs` ever runs, so CodeMirror
    // cannot reuse the tile of a widget whose patch left an element half-written.
    expect(victim.eq(new Patching())).toBe(false);
  });

  it("a widget tainted on one element is never patched on any OTHER element", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const victim = new Patching();
    const poisoned = victim.toDOM(view);
    // ⚠️ A SECOND element, and it never gets neutralised. Asserting on `poisoned`
    // itself would measure the `dom.dataset.quollWidgetError` guard instead — that
    // arm answers `false` whether or not the widget was tainted, so it would hide
    // this one completely.
    const other = victim.toDOM(view);
    const healthy = new Patching();
    expect(healthy.updateDOM(other, view, victim)).toBe(true); // baseline: patchable
    expect(other.textContent).toBe("patched:1");
    expect(new Throwing().updateDOM(poisoned, view, victim as unknown as Throwing)).toBe(false);
    // `other` carries no error stamp, so the taint on `victim` is the only thing
    // that can refuse this patch.
    expect(healthy.updateDOM(other, view, victim)).toBe(false);
    expect(other.textContent).toBe("patched:1"); // untouched
  });

  it("a placeholder element is never patched, even by a healthy widget", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The other half of the pair above: here the WIDGET is clean and the ELEMENT
    // is the neutralised one. CodeMirror's reuse cache does not know the
    // difference, so both arms have to hold on their own.
    const placeholder = new Throwing().toDOM(view);
    const healthy = new Patching();
    expect(healthy.updateDOM(placeholder, view, healthy)).toBe(false);
    expect(placeholder.textContent).toBe("⚠"); // untouched by the patch
    expect(healthy.patches).toBe(0); // `patchDOM` was never entered
  });

  it("a patch on a scope-less element mints a controller destroy can still reach", () => {
    const w = new Rebinder();
    // An element with no listener scope: `abortListeners` DELETES the entry, so
    // any element that has been through a destroy or a failed patch is in this
    // state, and CodeMirror's reuse cache can hand it back afterwards. If
    // `scopeOf` minted a controller without persisting it, the patch's listeners
    // would be bound to a signal no later teardown could find.
    const bare = document.createElement("div");
    expect(w.updateDOM(bare, view, w)).toBe(true);
    bare.click();
    expect(w.clicks).toBe(1); // the patch's listener is live
    w.destroy(bare);
    bare.click();
    expect(w.clicks).toBe(1); // …and the MINTED controller was reachable from destroy
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
