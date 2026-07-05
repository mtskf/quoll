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
// eq() is keyed on (docFrom, slice): same source bytes at the same document
// offset reuse the DOM; any byte change or a move rebuilds. `alt`/`safeUrl`
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
    // Caret target stored on the DOM so a reused element (updateDOM) reflects
    // the CURRENT docFrom, not a stale toDOM-time closure (mirrors the table
    // widget's data-doc-from margin fallback).
    root.dataset.docFrom = String(this.docFrom);

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
      const stamped = root.dataset.docFrom;
      view.dispatch({
        selection: { anchor: stamped !== undefined ? Number(stamped) : this.docFrom },
      });
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
    dom.dataset.docFrom = String(this.docFrom);
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
