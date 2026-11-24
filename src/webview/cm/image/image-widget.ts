// Block widget that renders a standalone Markdown image in place of its
// source line. Atomic from CodeMirror's perspective: ignoreEvent() returns
// true so CM does not synthesise state updates from widget DOM events. The
// DOM event still propagates; an explicit click listener dispatches a caret
// selection at the current block start, which fires imageBlockField's line-level reveal and
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
// The source slice determines widget equality, including alt text and the URL verdict.

import type { EditorView } from "@codemirror/view";
import type { AllowlistedUrl } from "../../../markdown/url-allowlist.js";
import { QuollWidget } from "../widget-base.js";
import { imageDimensionCache } from "./image-dimension-cache.js";

// Diagnostic latch: a live <img> that fails to load (file missing/renamed,
// outside localResourceRoots, typo, corrupt) is a first-class read-path
// outcome that otherwise collapses silently to the native broken-image glyph.
// Emit ONE triage breadcrumb per webview session so an "image won't show"
// report has a console signal; the native glyph stays as the visual. Symmetric
// with image-field.ts's `warnedUnresolvableImage` once-per-session latch.
let warnedImageLoadError = false;

export class ImageBlockWidget extends QuollWidget {
  readonly widgetName = "ImageBlockWidget";

  constructor(
    /** CommonMark-normalized image alt text (backslash/entity decode + emphasis
     *  flatten), computed upstream by `imageBlockField`. Drives `<img alt>` and
     *  the blocked placeholder's `aria-label` + visible text. */
    readonly alt: string,
    /** Render-gate verdict: the allowlisted URL, or null when blocked. */
    readonly safeUrl: AllowlistedUrl | null,
    /** Source slice `![alt](url)` — in sameAs() so DOM tracks byte changes. */
    readonly slice: string
  ) {
    super();
  }

  protected sameAs(other: QuollWidget): boolean {
    return other instanceof ImageBlockWidget && other.slice === this.slice;
  }

  protected render(view: EditorView, signal: AbortSignal): HTMLElement {
    // Wrapper <div> is the widget root, NOT <img>. It carries the
    // `quoll-block` marker whose `margin: 0` invariant (styles.css, widget
    // layer) keeps CM's getBoundingClientRect height measurement in lockstep
    // with the visible DOM; breathing room comes from padding on the wrapper.
    const root = document.createElement("div");
    root.className = "quoll-block quoll-image-block";

    if (this.safeUrl !== null) {
      const src = this.safeUrl;
      const img = document.createElement("img");
      img.className = "quoll-image";
      // Reserve space from a prior load so a rebuild (reseed / bounded
      // recompute of this block) does not reflow the
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
      // Bound to the base's per-render `signal` (QuollWidget), so
      // `QuollWidget.destroy` aborts it: a decode that lands AFTER CM discards
      // this widget no longer seeds the cache. Accepted — the alternative is an
      // unscoped listener, which is exactly the class this base exists to
      // remove. ⚠️ The cost is NOT one reflow: this listener is the cache's only
      // writer, so a widget discarded before its decode seeds NOTHING and the
      // next build starts from an empty cache too. The cost is an unreserved
      // reflow on EVERY build of that src until one build's decode completes
      // while the widget is still attached — self-healing, but bounded by that
      // CONDITION, not by a single occurrence. The `error` listener below is
      // scoped identically, so the same discard also loses the one `console.warn`
      // breadcrumb the session-level `warnedImageLoadError` latch allows.
      img.addEventListener(
        "load",
        () => {
          const width = img.naturalWidth;
          const height = img.naturalHeight;
          if (width > 0 && height > 0) {
            imageDimensionCache.set(src, { width, height });
          }
        },
        { signal }
      );
      // Symmetric error breadcrumb: a load failure (missing/renamed file,
      // out-of-localResourceRoots, typo, corrupt) otherwise leaves only the
      // native broken-image glyph. Log once per session so a triage report has
      // a console signal; the glyph remains the visual outcome.
      img.addEventListener(
        "error",
        () => {
          if (!warnedImageLoadError) {
            warnedImageLoadError = true;
            console.warn("[quoll] image failed to load", { src });
          }
        },
        { signal }
      );
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
    root.addEventListener(
      "click",
      () => {
        let anchor: number | undefined;
        try {
          if (!view.contentDOM.contains(root)) {
            console.error("[quoll] image widget root not in contentDOM");
            return;
          }
          anchor = view.posAtDOM(root);
          view.dispatch({ selection: { anchor } });
        } catch (err) {
          console.error("[quoll] image widget selection dispatch failed", { anchor, err });
        }
      },
      { signal }
    );

    return root;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
