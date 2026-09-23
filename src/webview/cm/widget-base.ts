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
// at `:140`. It is reached a SECOND time from the decoration diff, which runs
// one line after `updateDeco()` and well before the tile build:
// `findChangedDeco` (called `:2949`, declared `:3526`) → `RangeSet.compare` →
// `PointDecoration.eq` (`:355`) → `widgetsEq` (`:379`) → `compare`. That is
// inside the same `:2948`…`:2978` window, so a throw there wedges the view the
// same way. `false` is not an invented verdict — it is the conservative one,
// "not the same widget, rebuild it", identical to what `updateDOM` already
// returns when it declines.
//
// ⚠️ NOT wrapped, deliberately: `ignoreEvent`. Unlike `eq` it is consulted while
// dispatching a DOM event (`:4833`, `:7188`), never while a tile is being built,
// so its failure costs a gesture rather than the editor — and there a loud throw
// beats a guessed verdict. EVERY Quoll widget overrides it, by design, so the
// tripwire deliberately does NOT list it (listing it would fail on a healthy tree).
// Uncontained for the same "not on the tile-build path" reason, but overridden by
// NO widget today: `estimatedHeight` / `lineBreaks` (read at `:5954` / `:5955`,
// and both again in `heightRelevant` `:353` — all after state installation) and
// `coordsAt` (read during measurement, `:2112`). Those three ARE on the
// tripwire's roster, so adding one is a deliberate, reviewed decision rather than
// a default — see test/build/widget-containment-guard.test.ts.

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
  // trade for a path that only fires on a bug. Same reasoning, and nearly the same
  // wording, as `table/cell-render.ts`'s `renderCellSafely` catch (the
  // "anything finer costs a breakpoint" console.error) — which keeps `instanceof`
  // and accepts the Proxy residual named just below it; here that residual is
  // closed, see next paragraph.
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
   *  minification.
   *
   *  ⚠️ MUST be distinct from every other name that shares `reportOnce`'s
   *  per-(hook, widget) latch key. That namespace is NOT just the subclasses: a
   *  direct `containWidgetRender(name, …)` caller feeds its literal into the very
   *  same latch and the very same `data-quoll-widget-error` stamp (today that is
   *  `cm/fold/index.ts`'s `"foldPlaceholder"`). Two entries sharing a name means
   *  whichever fails FIRST silently swallows the other's only log line — the very
   *  collapse the per-pair latch exists to prevent — and both stamp the same
   *  `data-quoll-widget-error`, so the placeholders cannot be told apart either.
   *  Nothing in the type system can see two identical string literals; the AST
   *  walk in test/build/widget-containment-guard.test.ts is the only place this is
   *  enforceable, and it collects BOTH halves of the namespace — every
   *  `QuollWidget` subclass's `widgetName` and every `containWidgetRender` literal
   *  outside this file, in any callee spelling that walk can resolve by name (an
   *  ALIASED import is refused there rather than skipped). */
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
   *  ⚠️ MUST be idempotent. This runs TWICE on the patch-failure path: the
   *  `updateDOM` catch calls `prev.destroy(dom)`, and because that catch then
   *  returns `false`, CodeMirror leaves the tile unreused and `destroyDropped`
   *  (called at `:2979`, declared at `:3461`) destroys it again in the same
   *  update (`:2142`). Both calls carry the SAME element. Deleting from a
   *  WeakMap / aborting an already-aborted controller is the shape that
   *  satisfies this — see `TableBlockWidget.dispose`.
   *
   *  ⚠️ Unlike `render` and `patchDOM`, a failure here has NO safe substitute:
   *  the job is to stop something, and there is nothing to return instead. A
   *  `TableBlockWidget` whose `armedRelease` controller never aborts keeps
   *  DOCUMENT-level pointer listeners alive — answering for an editor that has
   *  forgotten it, and dispatching a selection over offsets that have moved.
   *  (Listeners bound during `render` are NOT this hook's problem: the base has
   *  already aborted their signal before it calls here. What lands here is what
   *  the signal cannot reach — which today is exactly that one case.) So the
   *  contract is on the implementor, not the wrapper: **disarm listeners as the
   *  FIRST statement, before anything that can throw.** The base contains the
   *  rest so one failed cleanup step cannot strand
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
      // makes new anchors with new click/auxclick handlers — both bindings are in
      // `attachLinkClickGuard`, cell-render.ts), and they must die with the
      // element they were bound to, not with the widget instance that happened to
      // bind them. `scopeOf` mints one for an element that predates the base
      // rather than leaving the patch unscoped.
      //
      // ⚠️ This scope is NOT re-cut per patch, deliberately. A patch that
      // REBUILDS what it bound to must scope those listeners itself — the way
      // `renderCellInto` (cell-render.ts) does, with a per-fill controller chained
      // to this one — because only the code doing the rebuilding knows that the
      // previous listeners' nodes are gone. Aborting this scope on every patch
      // instead looks equivalent and is not: `TableBlockWidget.patchDOM`'s
      // positional-shift arm (`from.slice === this.slice`) re-stamps offsets and
      // leaves the rendered cells — and their LIVE anchors — in place, so a
      // per-patch abort would disarm the click/auxclick guard on links the user
      // can still click, silently reopening the middle-click bypass of the host's
      // `open-external` re-validation.
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
      //    its tile cannot be adopted through either reuse route CodeMirror
      //    consults — it drops it and `destroyDropped` (called at `:2979`) tears
      //    it down in this same update, and every affected position is redrawn
      //    by a fresh `toDOM`. (The one route the taint CANNOT close is
      //    `compare`'s identity shortcut — see item 3.) That is what makes this
      //    cost nothing visually: a HEALTHY neighbour that happened to share the
      //    tile is not left showing a placeholder for the session.
      // 2. TEAR DOWN through the owning widget's own `destroy`, while the
      //    element is still the one the widget knows — a widget reaches its
      //    cleanup handle THROUGH it (`TableBlockWidget.dispose` looks up
      //    `armedRelease.get(dom)` to abort the document-level drag listeners),
      //    and the step below is about to strip that element bare. Contained, and
      //    dispose implementations are required to be idempotent (see its
      //    contract), so CodeMirror destroying the unreused tile again in this
      //    same update is a no-op.
      //    ⚠️ This step is also what aborts the element's listener scope, so the
      //    catch does NOT call `abortListeners` itself: `destroy` runs it as its
      //    unconditional FIRST statement, ahead of `dispose` and therefore ahead
      //    of `makePlaceholder` below, and `destroy` is on the build guard's
      //    GUARDED roster (test/build/widget-containment-guard.test.ts) so no
      //    subclass can RE-DECLARE one that skips it — as a method, as a class
      //    FIELD, or as a constructor `this.destroy = …`, all three of which the
      //    guard's member walk collects. A `prototype` assignment outside the
      //    class body and `Object.defineProperty` are NOT re-declarations and are
      //    the guard's declared syntactic gap (see its KNOWN GAPS), so what this
      //    rests on is "no subclass re-declares it", not "nothing can replace it".
      //    A separate abort here would be observationally equivalent — and
      //    misleading, since it would cover only this path while ordinary teardown
      //    (`destroyDropped` → `destroy`) relies on that first statement
      //    regardless.
      // 3. NEUTRALISE the element. Only observable in one case — `compare`'s
      //    `this == other` shortcut (`:140`) adopts a tile without consulting
      //    `eq` when a StateField re-emits the very same widget instance — and
      //    there an inert placeholder is the honest answer.
      tainted.add(prev);
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
      // Teardown runs from `destroyDropped` (`:2979`, just after `builder.run`
      // returns; the widget hook itself is called at `:2142`), so a throw here
      // escapes `DocView.update` mid-`updateInner` — it skips the height lock and
      // the `tile.sync()` the rest of that method performs, and propagates into
      // whatever dispatched. Unlike a render throw it does NOT strand a stale tile
      // (the new one is already assigned at `:2978`), but it still must not escape
      // into the caller. Containing it keeps the editor alive; see `dispose`'s
      // contract for what containment cannot do.
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
  // CodeMirror stamps this OUTSIDE `toDOM` (`WidgetTile.of` `:2144`; the stamp
  // itself at view dist:2148, guarded by `!widget.editable` at `:2147`, which
  // every Quoll widget satisfies) and only when it is building the element itself
  // (`if (!dom)`, `:2145`), so the PATCH path — where the element is neutralised
  // in place and can still be re-adopted through `compare`'s `this == other`
  // shortcut (`:140`) — has to restore it here or nobody does. CM reads the
  // attribute VALUE, not a flag it kept
  // (`betweenUneditable` `:3472`, `nextToUneditable` `:3515`), so a placeholder
  // that lost it is treated as editable content. The render path gets it stamped
  // again by CM regardless, which makes this line harmless there.
  el.contentEditable = "false";
  // Belt and braces for anything the signal did not cover (a listener bound
  // outside `render`, a focusable descendant CodeMirror kept): an inert subtree
  // takes no pointer or keyboard interaction at all. Chromium 102+; the
  // `engines.vscode` floor is ^1.94 = Chromium 124.
  el.inert = true;
  el.className = "quoll-widget-error";
  el.dataset.quollWidgetError = widgetName;
  // Actionable rather than merely descriptive: a block widget REPLACES its source
  // text, so the first thing the reader needs to know is that the FILE is intact.
  //
  // ⚠️ Residual, accepted and NOT closed here: `inert` removes this element from
  // the accessibility tree entirely, so `title` reaches sighted users only — for
  // an AT user a failed block widget is a silent disappearance, and the only other
  // trace is one `console.error` per (hook, widget) for the whole session. Closing
  // that needs an announcement OUTSIDE this element, through the same notice
  // channel the rest of the webview uses (`banners.ts`, `role="alert"`, as the
  // discarded-edit notice does) — which `cm/` must not import directly. Out of
  // scope for this change; dropping `inert` is not the alternative (it is what
  // keeps a half-built widget from taking input).
  el.title =
    "Quoll could not draw this element. Your Markdown source is unchanged — reload the editor window to try again.";
  el.textContent = "⚠";
  return el;
}
