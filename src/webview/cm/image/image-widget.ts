// Block widget that renders a standalone Markdown image in place of its
// source line. Atomic from CodeMirror's perspective: ignoreEvent() returns
// true so CM does not synthesise state updates from widget DOM events. The
// DOM event still propagates; an explicit click listener dispatches a caret
// selection at `docFrom`, which fires imageBlockField's line-level reveal and
// surfaces the raw `![alt](url)` source for editing (click-to-edit).
//
// The render-gate verdict is precomputed by imageBlockField and passed in as
// `safeUrl: AllowlistedUrl | null` (null = blocked). This widget NEVER re-gates
// and NEVER constructs an <img> for a blocked URL — the blocked branch builds a
// labelled, inert placeholder with no src attribute, so a non-allowlisted
// source can never become a live request. The `AllowlistedUrl` brand on the
// parameter makes "an ungated string reached img.src" a compile error.
//
// This widget MUST NOT create an <a> element: the click handler unconditionally
// dispatches a caret (unlike the table widget, which guards modifier-click on
// live links). An image widget has no links, so the guard is unnecessary; the
// "no <a>" invariant is pinned by a structural test.
//
// eq() is keyed on (docFrom, slice): a byte change OR a pure positional move
// (same slice, different docFrom) both return false, triggering updateDOM.
// updateDOM re-stamps docFrom and reuses the DOM when only the position moved
// (slice unchanged); a byte change forces a full toDOM rebuild. `alt`/`safeUrl`
// are pure functions of `slice`, so they need not participate in eq().

import { type EditorView, WidgetType } from "@codemirror/view";
import type { AllowlistedUrl } from "../../../markdown/url-allowlist.js";
import { imageDimensionCache } from "./image-dimension-cache.js";

// Diagnostic latch: a live <img> that fails to load (file missing/renamed,
// outside localResourceRoots, typo, corrupt) is a first-class read-path
// outcome that otherwise collapses silently to the native broken-image glyph.
// Emit ONE triage breadcrumb per webview session so an "image won't show"
// report has a console signal; the native glyph stays as the visual. Symmetric
// with image-field.ts's `warnedUnresolvableImage` once-per-session latch.
let warnedImageLoadError = false;

// The block's CURRENT first-byte offset, keyed on the widget's root element.
//
// Keyed on the element rather than held in the `toDOM` closure because
// `updateDOM` reuses that element across widget instances: after a distant edit
// shifts this block, CodeMirror builds a NEW widget, `eq()` returns false, and
// `updateDOM` re-points the reused DOM — but it cannot re-bind the click
// listener, whose captured `this` is the OLD instance. So the new instance
// needs a channel to hand the current offset to the existing listener, and the
// channel has to be updatable exactly when the position moves, which
// `updateDOM` can do and the closure cannot. A WeakMap so a discarded root
// takes its entry with it. Same pattern, same reason, as table-widget.ts's
// `blockStart`.
//
// A `number` end to end: nothing is stringified, parsed, or read back from the
// DOM, so there is no malformed-value state to validate against. (`checkSelection`
// in @codemirror/state only rejects `range.to > doc.length`, so a `NaN` /
// negative / fractional anchor would otherwise install a silently broken
// selection that no try/catch can observe.)
const blockStart = new WeakMap<HTMLElement, number>();

export class ImageBlockWidget extends WidgetType {
  constructor(
    /** CommonMark-normalized image alt text (backslash/entity decode + emphasis
     *  flatten), computed upstream by `imageBlockField`. Drives `<img alt>` and
     *  the blocked placeholder's `aria-label` + visible text. */
    readonly alt: string,
    /** Render-gate verdict: the allowlisted URL, or null when blocked. */
    readonly safeUrl: AllowlistedUrl | null,
    /** Source slice `![alt](url)` — in eq() so DOM tracks byte changes. */
    readonly slice: string,
    /** Absolute doc offset of the widget's first byte (caret target). */
    readonly docFrom: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ImageBlockWidget &&
      other.docFrom === this.docFrom &&
      other.slice === this.slice
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // Wrapper <div> is the widget root, NOT <img>. It carries the
    // `quoll-block` marker whose `margin: 0` invariant (styles.css, widget
    // layer) keeps CM's getBoundingClientRect height measurement in lockstep
    // with the visible DOM; breathing room comes from padding on the wrapper.
    const root = document.createElement("div");
    root.className = "quoll-block quoll-image-block";
    // The caret target travels through `blockStart`, NOT through this
    // attribute: `data-doc-from` is written for DOM inspection (and read by
    // tests that pin the re-stamp) and is NEVER read back — see `blockStart`
    // above for why a position must not be parsed back out of the DOM.
    root.dataset.docFrom = String(this.docFrom);
    blockStart.set(root, this.docFrom);

    if (this.safeUrl !== null) {
      const src = this.safeUrl;
      const img = document.createElement("img");
      img.className = "quoll-image";
      // Reserve space from a prior load so a rebuild (reseed / bounded
      // recompute that moved or rebuilt this widget) does not reflow the
      // document while the image re-decodes. The CSS (max-width:100%;
      // height:auto) scales the intrinsic size down; the width/height attrs
      // give the browser the aspect ratio to reserve before paint.
      const cached = imageDimensionCache.get(src);
      if (cached) {
        img.width = cached.width;
        img.height = cached.height;
      }
      img.src = src; // render-gate verified upstream (decode → renderSafeUrl → resolve)
      img.alt = this.alt;
      // Record natural dimensions once the image has decoded, keyed by the
      // resolved src. Guard against a failed load (naturalWidth/Height === 0).
      // The listener is not explicitly removed: it is attached to the <img>
      // this widget owns, so it is garbage-collected with the DOM when CM
      // discards the widget (same lifecycle as the `click` listener below). A
      // load firing after discard merely writes the cache — no view access, no
      // leak.
      img.addEventListener("load", () => {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        if (width > 0 && height > 0) {
          imageDimensionCache.set(src, { width, height });
        }
      });
      // Symmetric error breadcrumb: a load failure (missing/renamed file,
      // out-of-localResourceRoots, typo, corrupt) otherwise leaves only the
      // native broken-image glyph. Log once per session so a triage report has
      // a console signal; the glyph remains the visual outcome.
      img.addEventListener("error", () => {
        if (!warnedImageLoadError) {
          warnedImageLoadError = true;
          console.warn("[quoll] image failed to load", { src });
        }
      });
      root.appendChild(img);
    } else {
      // No <img>, no src — structurally impossible to fire a network request.
      // role="img" + aria-label give assistive tech an equivalent to the alt.
      const ph = document.createElement("span");
      ph.className = "quoll-image-blocked";
      ph.setAttribute("role", "img");
      ph.setAttribute("aria-label", this.alt ? `Blocked image: ${this.alt}` : "Blocked image");
      ph.textContent = this.alt ? `\u{1F6AB} ${this.alt}` : "\u{1F6AB} Blocked image";
      root.appendChild(ph);
    }

    // Click anywhere on the widget places the caret on the widget's first
    // source line → imageBlockField's line-level reveal-on-caret fires → raw
    // source surfaces and becomes editable. No <a> exists inside an image
    // widget, so (unlike the table widget) there is no modifier-click
    // navigation exception to guard.
    root.addEventListener("click", () => {
      // Falling back to `this.docFrom` totalizes the `number | undefined` read;
      // it is not the stale-closure hazard coming back. The entry is set above,
      // in the same breath as attaching this listener, and at toDOM time the
      // closure value IS the current one — so a miss is unreachable by
      // construction. Logged, not silently trusted, so a future regression of
      // that invariant is observable instead of silently reintroducing the
      // stale-caret bug this WeakMap exists to fix.
      let anchor = blockStart.get(root);
      if (anchor === undefined) {
        // `slice` identifies WHICH widget tripped it — a document can hold many
        // images, and `fallback` alone would not say which one. Matches the
        // source-identifying payload of this file's other breadcrumb
        // (`{ src }` on a failed load).
        console.error("[quoll] image widget blockStart miss — invariant violated", {
          slice: this.slice,
          fallback: this.docFrom,
        });
        anchor = this.docFrom;
      }
      // A `number` anchor does not make the dispatch infallible — see
      // table-widget.ts's `dispatchSelection` for the enumeration of what still
      // throws (out-of-range after a shrinking edit, CodeMirror's re-entrancy
      // error, a throwing transaction filter). The range bound is deliberately
      // NOT re-checked against `view.state.doc.length`: CodeMirror owns that
      // invariant and enforces it by throwing, and a second copy of the rule
      // here could drift from it. The throw must not escape into a DOM listener
      // unlogged — the gesture is lost, the editor keeps running.
      try {
        view.dispatch({ selection: { anchor } });
      } catch (err) {
        console.error("[quoll] image widget selection dispatch failed", { anchor, err });
      }
    });

    return root;
  }

  updateDOM(dom: HTMLElement, _view: EditorView, from: ImageBlockWidget): boolean {
    // CM calls updateDOM only when eq() returned false, passing the prior
    // same-class widget as `from`. eq() keys on (docFrom, slice); alt/safeUrl
    // are pure functions of the slice (and the static resource-base facet). So
    // from.slice === this.slice means only docFrom shifted — re-stamp the caret
    // target and reuse the <img> (avoids per-keystroke <img> recreation + reflow
    // when typing above the image). A changed slice returns false so CM does a
    // full toDOM rebuild, which re-gates the URL via the freshly-passed
    // safeUrl — updateDOM NEVER re-gates or mutates src itself.
    if (!dom.classList.contains("quoll-image-block")) {
      return false;
    }
    if (from.slice !== this.slice) {
      return false;
    }
    // Re-point the caret channel the click listener actually reads. The
    // attribute beside it is inspection-only (see toDOM) — dropping THIS line
    // would leave the reused listener dispatching the old offset while the DOM
    // still looked correct.
    dom.dataset.docFrom = String(this.docFrom);
    blockStart.set(dom, this.docFrom);
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
