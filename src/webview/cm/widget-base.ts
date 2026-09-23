// The one place a Quoll widget's DOM hooks can throw from.
//
// ⚠️ Why a base class rather than a try/catch at the call sites that apply a
// document: CodeMirror reaches these hooks through TWO doors, and only one of
// them is ours. `EditorView.update` runs `docView.update` at
// `@codemirror/view/dist:7965` (the dispatch door), and `EditorView.measure`
// runs the SAME method at `:8150` from the rAF measure loop (the scroll door) —
// a widget entering the viewport builds its DOM with no host message and no
// `applyDocument` call anywhere on the stack. A catch in `applyDocument` closes
// the first door and cannot see the second.
//
// ⚠️ Why it matters that they never throw: `DocView.update` advances the
// decoration set in `updateDeco()` (`:2948`) and only THEN builds tiles at
// `this.tile = builder.run(...)` (`:2978`). A throw in between leaves
// decorations advanced against a stale `tile`, and every later tile walk dies
// with "Cannot destructure property 'tile' of 'parents.pop(...)'" — measured:
// the view never recovers, not even for a plain-text document with no widget in
// it, while `view.state.doc` keeps moving. The rendered DOM and the document
// diverge permanently. Upstream of that, the new `EditorState` is installed
// BEFORE the DOM phase (`ViewState.update`'s first statement, `:6233`), so the
// throw also strands whatever bookkeeping the caller runs after `dispatch`
// returns — see `.claude/docs/LEARNING.md` and `cm/seed.ts`.
//
// So the contract here is not "handle the error" but "there is no error to
// handle". Widgets are display-only (ARCHITECTURE.md §5), so a placeholder costs
// a visual, never a document byte — with ONE exception stated on `dispose` below.
//
// ⚠️ `eq` IS contained: `compare` runs at `:2552` INSIDE the reuse scan of the
// very `builder.run(...)` whose return assigns `this.tile`, and delegates to `eq`
// at `:140` (`findChangedDeco` calls it again at `:379`). `false` is not an
// invented verdict — it is the conservative one, "not the same widget, rebuild
// it", identical to what `updateDOM` already returns when it declines.
//
// ⚠️ NOT wrapped, deliberately: `ignoreEvent`. Unlike `eq` it is consulted while
// dispatching a DOM event (`:4833`, `:7188`), never while a tile is being built,
// so its failure costs a gesture rather than the editor — and there a loud throw
// beats a guessed verdict. Same for `estimatedHeight` / `lineBreaks`, which no
// Quoll widget overrides; the tripwire flags an override of any of them so the
// decision is re-made deliberately rather than by default.

import { type EditorView, WidgetType } from "@codemirror/view";

/** Which contained hook failed. Part of the log's latch key. */
type WidgetHook = "render" | "patchDOM" | "sameAs" | "dispose";

// ⚠️ Keyed per (hook, widget), NOT one boolean for the whole session. A single
// latch would let one harmless transient render failure swallow the only signal a
// LATER `dispose` failure in a different widget would ever produce — and a
// `dispose` failure is the one class here that can reach document bytes (below).
// The repo's precedent is per-category latches, not one: `cell-render.ts` carries
// `loggedUntiledMap` AND `loggedRenderThrow`, and `image-widget.ts` a third.
const logged = new Set<string>();

function reportOnce(hook: WidgetHook, widget: string, err: unknown): void {
  const key = `${hook}:${widget}`;
  if (logged.has(key)) {
    return;
  }
  logged.add(key);
  // ⚠️ NO property of `err` is read, and `err` itself is NOT passed: `console`
  // reads `message` / `stack` to format, and a getter that throws would re-enter
  // this handler from inside the very catch whose job is to contain it. A fixed
  // hook name, a fixed widget name and a coarse kind are what this module can
  // honestly vouch for; recovering more costs a breakpoint, which is the right
  // trade for a path that only fires on a bug. Same reasoning, and the same
  // wording, as `table/cell-render.ts:492`.
  //
  // ⚠️ `typeof`, NOT `err instanceof Error`. `instanceof` runs the value's
  // `getPrototypeOf` trap, so a thrown Proxy (or a revoked one) makes the
  // CLASSIFIER throw from inside the catch — measured. `cell-render.ts` names
  // that same residual and accepts it; here it costs nothing to close, because
  // `typeof` touches no trap at all.
  console.error("[quoll] widget hook threw; rendering an inert placeholder", {
    widget,
    hook,
    errKind: typeof err,
  });
}

// The listener scope of each element a widget built. Aborting it removes every
// listener the widget bound during `render` — the generic answer to "a widget's
// listeners outlived its element", which no per-widget `dispose` can be trusted
// to give (the checkbox and image widgets have no `dispose` at all).
const listenerScope = new WeakMap<HTMLElement, AbortController>();

function abortListeners(dom: HTMLElement): void {
  listenerScope.get(dom)?.abort();
  listenerScope.delete(dom);
}

/** The element's listener scope, minted on demand. An element CodeMirror built
 *  before this base existed — or one adopted from the reuse cache — still gets a
 *  scope, so a patch can never be left with nowhere to bind. */
function scopeOf(dom: HTMLElement): AbortController {
  let controller = listenerScope.get(dom);
  if (controller === undefined) {
    controller = new AbortController();
    listenerScope.set(dom, controller);
  }
  return controller;
}

// Widgets whose `patchDOM` threw. A tainted widget is never equal to anything
// and is never patched, so CodeMirror stops reusing its tile and rebuilds
// through the contained `toDOM`. A WeakSet so a discarded widget takes its entry
// with it — the same lifetime idiom as the WeakMaps in table-widget.ts.
const tainted = new WeakSet<QuollWidget>();

/** Test seam: clear the per-(hook, widget) log latches. Production never calls it. */
export function resetWidgetThrowLatchForTest(): void {
  logged.clear();
}

export abstract class QuollWidget extends WidgetType {
  /** This widget's name for the placeholder stamp and the log.
   *
   *  ⚠️ NOT `this.constructor.name`: the production bundle is minified with no
   *  `keepNames` (`esbuild.config.mjs:46`), so a shipped build would stamp
   *  `data-quoll-widget-error="Ie"` and log `widget: "Ie"` while the unminified
   *  test build stays perfectly readable — the diagnostic would rot exactly where
   *  it is needed and nowhere a test could see. A literal per subclass survives
   *  minification. */
  abstract readonly widgetName: string;

  /** Build this widget's DOM. Replaces `toDOM` — the base owns that name so the
   *  containment cannot be bypassed by a subclass that forgets it.
   *
   *  ⚠️ `signal` is not optional decoration: **every `addEventListener` bound
   *  here must pass `{ signal }`.** The base aborts it when the element is torn
   *  down OR when a patch fails, which is the only way to guarantee that a
   *  widget's listeners cannot outlive the element they were bound to.
   *  Measured why this matters: `compare` short-circuits on `this == other`
   *  (`:140`) BEFORE consulting `eq`, so a StateField that re-emits the same
   *  widget instance can have CodeMirror adopt an element a failed patch already
   *  poisoned — with the old listeners still attached and still in the live
   *  tree. Codex reproduced clicking such a placeholder and writing
   *  `- [x] beta` to the DOCUMENT through a task checkbox. The taint below stops
   *  every other reuse route; this signal is what closes that last one.
   *
   *  Listeners a widget arms LATER on `document` (the table's drag release) are
   *  not covered — nothing bound them during render — and stay that widget's own
   *  business in `dispose`. */
  protected abstract render(view: EditorView, signal: AbortSignal): HTMLElement;

  /** Widget identity. Replaces `eq`; CodeMirror has already checked that both
   *  sides share a constructor before this runs (`compare`, `:140`). */
  protected abstract sameAs(other: QuollWidget): boolean;

  /** Optional in-place patch. Replaces `updateDOM`; same return contract
   *  (`true` = patched, `false` = rebuild me). */
  protected patchDOM?(dom: HTMLElement, view: EditorView, prev: this, signal: AbortSignal): boolean;

  /** Optional teardown. Replaces `destroy`.
   *
   *  ⚠️ Unlike `render` and `patchDOM`, a failure here has NO safe substitute:
   *  the job is to stop something, and there is nothing to return instead. A
   *  `LanguagePickerWidget` whose listener survives can still fire a stale
   *  `change` into `setFenceLanguage` and WRITE TO THE DOCUMENT; a
   *  `TableBlockWidget` whose `AbortController` never aborts keeps document-level
   *  pointer listeners alive. So the contract is on the implementor, not the
   *  wrapper: **disarm listeners as the FIRST statement, before anything that can
   *  throw.** The base contains the rest so one failed cleanup step cannot strand
   *  the tile builder, but it cannot make a half-torn-down widget inert for you. */
  protected dispose?(dom: HTMLElement): void;

  // ⚠️ Do not override the four hooks below in a subclass — overriding one
  // silently removes its containment. test/build/widget-containment-guard.test.ts
  // pins that nothing does.

  toDOM(view: EditorView): HTMLElement {
    return containWidgetRender(this.widgetName, (signal) => this.render(view, signal));
  }

  eq(other: WidgetType): boolean {
    if (tainted.has(this)) {
      // A widget whose patch threw must never be recognised as "the same" one
      // again, or CodeMirror reuses the element that patch left half-written.
      return false;
    }
    try {
      return this.sameAs(other as QuollWidget);
    } catch (err) {
      reportOnce("sameAs", this.widgetName, err);
      // "Not the same widget" — CodeMirror discards the old tile and rebuilds
      // through the contained `toDOM`. The opposite default would reuse DOM for
      // a widget we failed to identify.
      return false;
    }
  }

  updateDOM(dom: HTMLElement, view: EditorView, prev: this): boolean {
    if (
      this.patchDOM === undefined ||
      // Never patch an element a failed patch already touched, and never patch
      // on behalf of a widget whose tile is poisoned. Both force a fresh,
      // contained `toDOM` instead.
      tainted.has(prev) ||
      dom.dataset.quollWidgetError !== undefined
    ) {
      return false; // CodeMirror's own default: rebuild.
    }
    try {
      // ⚠️ The ELEMENT's signal, not a fresh one: a patch binds listeners too
      // (the table's `patchRow` → `renderCellInto` → `attachLinkClickGuard`
      // makes new anchors with new click/auxclick handlers, `cell-render.ts:85,119`),
      // and they must die with the element they were bound to, not with the
      // widget instance that happened to bind them. `scopeOf` mints one for an
      // element that predates the base rather than leaving the patch unscoped.
      return this.patchDOM(dom, view, prev, scopeOf(dom).signal);
    } catch (err) {
      reportOnce("patchDOM", this.widgetName, err);
      // ⚠️ Returning `false` is NOT enough on its own. `findWidget` (`:2540`)
      // leaves a rejected candidate in the reuse cache, so a LATER widget in the
      // same builder run can adopt this very element — and a patch that threw
      // half-way has already mutated it (the table widget rewrites offsets before
      // cells; the picker calls `replaceChildren()` before rebuilding options).
      // Measured: expected ["B", "A"], got ["B", "HALF-PATCHED"], and with the
      // checkbox widget migrated, clicking such an adopted element wrote
      // `- [x] beta` to the DOCUMENT. Three things, in this order:
      //
      // 1. TAINT the widget that owns this element. A tainted widget never
      //    compares equal (see `eq`) and is never patched (the guard above), so
      //    its tile cannot be adopted at all — CodeMirror drops it and
      //    `destroyDropped` (`:2979`) tears it down in this same update, and
      //    every affected position is redrawn by a fresh `toDOM`. That is what
      //    makes this cost nothing visually: a HEALTHY neighbour that happened
      //    to share the tile is not left showing a placeholder for the session.
      // 2. TEAR DOWN through the owning widget's own `destroy`, while the
      //    children are still present — a widget may reach its cleanup handle
      //    through them (the language picker finds its `AbortController` by
      //    querying for its `<select>`). Contained, and dispose implementations
      //    are required to be idempotent, so CodeMirror calling it again is a
      //    no-op.
      // 3. NEUTRALISE the element. Only observable in one case — `compare`'s
      //    `this == other` shortcut (`:140`) adopts a tile without consulting
      //    `eq` when a StateField re-emits the very same widget instance — and
      //    there an inert placeholder is the honest answer.
      tainted.add(prev);
      abortListeners(dom);
      prev.destroy(dom);
      makePlaceholder(dom, this.widgetName);
      return false;
    }
  }

  destroy(dom: HTMLElement): void {
    // Unconditional and first: every listener this element acquired during
    // `render` goes, whether or not the widget has a `dispose` of its own.
    abortListeners(dom);
    if (this.dispose === undefined) {
      return;
    }
    try {
      this.dispose(dom);
    } catch (err) {
      // Teardown runs from `destroyDropped` inside the same builder run
      // (`:2142`), so a throw here wedges the view exactly like a render throw.
      // Containing it keeps the editor alive; see `dispose`'s contract for what
      // containment cannot do.
      reportOnce("dispose", this.widgetName, err);
    }
  }
}

/** The render containment, exposed on its own because one caller cannot inherit
 *  it: `foldPlaceholderDOM` (cm/fold/index.ts) is invoked by CodeMirror's OWN
 *  fold widget (`@codemirror/language/dist:1535`), so no base class of ours sits
 *  on that stack. Same fallback, same latch, one definition. */
export function containWidgetRender(
  name: string,
  build: (signal: AbortSignal) => HTMLElement
): HTMLElement {
  const controller = new AbortController();
  try {
    const dom = build(controller.signal);
    // Keyed on the ELEMENT, not on the widget: CodeMirror reuses an element
    // across widget instances, and it is the element's listeners we have to be
    // able to reach later. Same lifetime idiom as table-widget.ts's WeakMaps.
    listenerScope.set(dom, controller);
    return dom;
  } catch (err) {
    // ⚠️ Abort BEFORE returning the placeholder. A render that threw half-way
    // may already have bound listeners to nodes it never returned, and the
    // placeholder is a DIFFERENT element — registering the controller against it
    // would leave those listeners alive until an element that does not own them
    // is destroyed, which is never. Measured: a half-built language picker's
    // detached `<select>` still took a `change` and rewrote ```ts to ```js.
    // `inert` cannot help here either; it is on the placeholder, not on the
    // orphan.
    controller.abort();
    reportOnce("render", name, err);
    return makePlaceholder(document.createElement("span"), name);
  }
}

/** Turn `el` into the inert stand-in, in place. In place because the patch path
 *  has to neutralise an element CodeMirror already holds a reference to.
 *
 *  A visible glyph rather than an empty node: a block widget REPLACES its source
 *  text, so an empty placeholder would read as "the content vanished" with
 *  nothing to notice. `title` carries the explanation without costing layout.
 *  Built with createElement + textContent — `innerHTML` is banned under `src/**`
 *  (test/markdown/url-choke-point.test.ts). */
function makePlaceholder(el: HTMLElement, widgetName: string): HTMLElement {
  el.replaceChildren();
  // Strip what the old widget stamped. `inert` already closes the functional
  // side, but an element still advertising `role="checkbox"` / `aria-checked` /
  // `tabindex` sends the next person reading devtools somewhere wrong — and a
  // neutralised element should not describe itself as the thing it failed to be.
  for (const name of [...el.getAttributeNames()]) {
    el.removeAttribute(name);
  }
  // Belt and braces for anything the signal did not cover (a listener bound
  // outside `render`, a focusable descendant CodeMirror kept): an inert subtree
  // takes no pointer or keyboard interaction at all. Chromium 102+; the
  // `engines.vscode` floor is ^1.94 = Chromium 124.
  el.inert = true;
  el.className = "quoll-widget-error";
  el.dataset.quollWidgetError = widgetName;
  el.title = "Quoll could not draw this element";
  el.textContent = "⚠";
  return el;
}
