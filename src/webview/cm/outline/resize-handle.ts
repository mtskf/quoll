// The outline sidebar's runtime resize affordance: a focusable WAI-ARIA window
// splitter (role=separator) that lives as a host child (a sibling of the
// sidebar, NOT a sidebar child) pinned to the sidebar's right edge via
// `left: var(--quoll-outline-sidebar-width)`. Dragging it — or nudging it with
// the keyboard — rewrites that var inline on the host, which moves the sidebar
// edge, the pinned flex-basis, AND the handle together: one source of truth for
// the runtime width. Only interactive while the sidebar is open (styles.css
// gates its display).
//
// Extracted from outline-panel.ts as a self-contained concern: it owns its drag
// state, the width-clamp math, the persisted-width restore/seed, and every
// `--quoll-outline-sidebar-width` write. It reaches back into the panel ONLY
// through the small typed `deps` callback set (hover-close scheduling, focus-out
// dismiss, Escape-close) — the panel never touches resize internals and this
// module never touches the sidebar's own state.

import { patchPersistedState, readPersistedState } from "../../host.js";

/** Runtime-resizable sidebar width bounds (px). The stylesheet default
 *  (--quoll-outline-sidebar-width: 260px) applies until the user drags; a drag
 *  overrides the var inline on the host and persists the value. This clamp
 *  bounds the STORED width at drag/restore time; styles.css additionally caps
 *  the LIVE display at min(var, 80%) of the host (re-evaluated on layout, for
 *  host-shrink) using the SAME expression on the sidebar and the handle so they
 *  never desync. The two are complementary — both keep the editor column alive. */
const MIN_WIDTH_PX = 180;
const MAX_WIDTH_PX = 600;
/** Keyboard-resize nudge (px) per Arrow press on the focused separator. Coarse
 *  enough that a handful of presses spans the range, in the spirit of VS Code's
 *  keyboard sash nudges; Home jumps to MIN_WIDTH_PX. End requests MAX_WIDTH_PX but
 *  is still subject to clampWidth's host-relative 80% cap (see the comment above),
 *  so on a narrow host it lands below the documented max. */
const RESIZE_STEP_PX = 16;
/** Stylesheet baseline for --quoll-outline-sidebar-width (styles.css) — the
 *  width the keyboard math and aria-valuenow read before any inline width is set.
 *  Exported so a contract test machine-enforces parity with the CSS default (the
 *  test reads styles.css and fails if the two diverge — not just this comment). */
export const DEFAULT_WIDTH_PX = 260;
/** Persisted view-state key (flat, survives reload) — see readPersistedState.
 *  Flat + namespaced by name so it shallow-merges alongside any future keys
 *  without a nested schema (one key today). */
const WIDTH_STATE_KEY = "outlineWidthPx";

/** The panel-owned collaborators the handle calls back into. The handle knows
 *  nothing of the panel's fields — it only asks it to (un)schedule the hover
 *  close, dismiss the transient overlay on focus-out, and close on Escape. */
export type ResizeHandleDeps = {
  /** The `.quoll-editor` host: the positioned ancestor whose
   *  `--quoll-outline-sidebar-width` var every width write targets, and the
   *  element the handle is appended to (by the caller). */
  host: HTMLElement;
  /** The sidebar's element id, for the separator's `aria-controls`. */
  sidebarId: string;
  /** Cancel a pending hover-close (pointer entered the handle / a drag started). */
  cancelScheduledClose: () => void;
  /** Arm the hover-close (pointer left the handle toward the editor). */
  scheduleClose: () => void;
  /** Focus left the handle — the panel decides whether to dismiss the overlay
   *  (it exempts focus moving back into the sidebar / onto the handle). */
  onFocusOut: (e: FocusEvent) => void;
  /** Escape pressed while the handle has focus — close the overlay (the handle
   *  is a host child, so the sidebar's own Escape handler never sees its keys). */
  onEscapeClose: () => void;
};

/** The mounted resize handle. `el` is the separator element the caller appends
 *  to the host and references in its focus-region checks; `isResizing` lets the
 *  panel's hover-close policy no-op mid-drag (in happy-dom, where pointer capture
 *  is a no-op, boundary events still fire during a drag, so the guard is live);
 *  `destroy` flushes an in-flight drag and removes the element (with its pointer
 *  listeners). */
export type ResizeHandle = {
  el: HTMLElement;
  isResizing: () => boolean;
  destroy: () => void;
};

export function createResizeHandle(deps: ResizeHandleDeps): ResizeHandle {
  const { host } = deps;

  let resizing = false;
  /** The pointerId that started the active drag; guards against a second
   *  pointer's events hijacking the resize. */
  let resizePointerId: number | null = null;
  /** True once a pointermove actually changed the width during this drag. Only
   *  a moved drag persists — a click-without-drag (pointerdown→up, no move)
   *  must not fire a redundant setState. */
  let resizeMoved = false;

  function clampWidth(px: number): number {
    // happy-dom / pre-layout: clientWidth 0 ⇒ no viewport bound yet, use the
    // absolute ceiling. In a real browser, also cap at 80% of the host width so
    // the editor column survives at drag/restore time. styles.css re-applies the
    // same 80%-of-host cap live via min(var, 80%) for later host shrinks; the two
    // caps agree, so a value this clamp passes is never re-capped on a stable host.
    const hostWidth = host.clientWidth;
    const upper = hostWidth > 0 ? Math.min(MAX_WIDTH_PX, hostWidth * 0.8) : MAX_WIDTH_PX;
    return Math.round(Math.max(MIN_WIDTH_PX, Math.min(upper, px)));
  }

  /** Set the width var from a pointer's clientX (relative to the host's left). */
  function applyResize(clientX: number): void {
    const width = clampWidth(clientX - host.getBoundingClientRect().left);
    host.style.setProperty("--quoll-outline-sidebar-width", `${width}px`);
    updateResizeAria();
  }

  /** The effective sidebar width (px): the inline var if set, else the stylesheet
   *  default. The numeric baseline the keyboard nudges and aria-valuenow read. */
  function currentWidthPx(): number {
    const raw = Number.parseInt(host.style.getPropertyValue("--quoll-outline-sidebar-width"), 10);
    return Number.isFinite(raw) ? raw : DEFAULT_WIDTH_PX;
  }

  /** Reflect the live width onto the separator's aria-valuenow (AT read-out).
   *  Called from every width mutation — pointer drag and keyboard alike. */
  function updateResizeAria(): void {
    el.setAttribute("aria-valuenow", String(currentWidthPx()));
  }

  /** Commit a keyboard-chosen width: clamp, write the var, sync aria, persist.
   *  Unlike the pointer drag (one persist at drag-end), each Arrow/Home/End press
   *  is its own discrete, already-committed width — so it persists immediately. */
  function setWidth(px: number): void {
    const width = clampWidth(px);
    host.style.setProperty("--quoll-outline-sidebar-width", `${width}px`);
    updateResizeAria();
    patchPersistedState({ [WIDTH_STATE_KEY]: width });
  }

  /** Keyboard resize on the focused separator (WAI-ARIA window-splitter keys):
   *  Left/Right nudge by RESIZE_STEP_PX. Home jumps to MIN_WIDTH_PX; End requests
   *  MAX_WIDTH_PX but setWidth's clampWidth call still applies the host-relative
   *  80% cap, so End may land below MAX_WIDTH_PX on a narrow host. Escape closes
   *  the overlay (mirrors the sidebar's Escape); Tab and everything else bubble. */
  function onResizeKeydown(e: KeyboardEvent): void {
    // Escape closes the transient overlay from the handle (the handle is a host
    // child, so the sidebar's Escape handler never sees its keydowns). Matches the
    // sidebar Escape path: setOpen(false) also unpins via its invariant.
    if (e.key === "Escape") {
      e.preventDefault();
      deps.onEscapeClose();
      return;
    }
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = currentWidthPx() - RESIZE_STEP_PX;
        break;
      case "ArrowRight":
        next = currentWidthPx() + RESIZE_STEP_PX;
        break;
      case "Home":
        next = MIN_WIDTH_PX;
        break;
      case "End":
        next = MAX_WIDTH_PX;
        break;
      default:
        return;
    }
    e.preventDefault();
    setWidth(next);
  }

  function onResizePointerDown(e: PointerEvent): void {
    if (resizing) {
      return; // a second pointer must not hijack an active drag
    }
    e.preventDefault();
    resizing = true;
    resizeMoved = false;
    resizePointerId = e.pointerId;
    // Route subsequent moves/up to the handle even outside the iframe. Guarded:
    // happy-dom has no setPointerCapture.
    el.setPointerCapture?.(e.pointerId);
    // Dragging in overlay mode moves the pointer out of the sidebar — cancel any
    // armed hover-close so the surface can't vanish mid-drag (scheduleClose also
    // early-returns while resizing).
    deps.cancelScheduledClose();
  }

  function onResizePointerMove(e: PointerEvent): void {
    if (!resizing || e.pointerId !== resizePointerId) {
      return;
    }
    resizeMoved = true;
    applyResize(e.clientX);
  }

  /** Unified drag-end for pointerup AND pointercancel. */
  function onResizePointerEnd(e: PointerEvent): void {
    if (!resizing || e.pointerId !== resizePointerId) {
      return;
    }
    // pointercancel carries no useful clientX — only apply on pointerup.
    if (e.type === "pointerup") {
      applyResize(e.clientX);
    }
    endResize();
  }

  /** Stop the drag and persist the committed width. Idempotent + shared by the
   *  pointer-end path and destroy-mid-drag. Only a drag that actually moved
   *  persists — a click-without-drag fires no redundant setState. */
  function endResize(): void {
    if (!resizing) {
      return;
    }
    resizing = false;
    if (resizePointerId !== null) {
      el.releasePointerCapture?.(resizePointerId);
      resizePointerId = null;
    }
    if (!resizeMoved) {
      return; // no movement ⇒ no new width to persist
    }
    resizeMoved = false;
    const width = Number.parseInt(host.style.getPropertyValue("--quoll-outline-sidebar-width"), 10);
    if (Number.isFinite(width)) {
      patchPersistedState({ [WIDTH_STATE_KEY]: width });
    }
  }

  // Listeners live on the handle + pointer capture, so a release outside the
  // iframe still ends the drag (pointerup/pointercancel), and destroy() cleans
  // them up.
  const el = document.createElement("div");
  el.className = "quoll-outline-resize-handle";
  // WAI-ARIA window-splitter role wiring: aria-value* report the live width to
  // AT; aria-controls ties the separator to the sidebar it sizes.
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.setAttribute("aria-label", "Resize outline sidebar");
  el.setAttribute("aria-controls", deps.sidebarId);
  el.setAttribute("aria-valuemin", String(MIN_WIDTH_PX));
  el.setAttribute("aria-valuemax", String(MAX_WIDTH_PX));
  // A permanent tab stop is safe: styles.css gives the closed handle
  // display:none, so it drops out of the tab order when the sidebar is closed —
  // mirroring the inert sidebar (no phantom stop while the outline is shut).
  el.tabIndex = 0;
  // These handlers are module-local free functions (no `this`), so they bind
  // directly — no `(e) => fn(e)` forwarding wrapper needed.
  el.addEventListener("pointerdown", onResizePointerDown);
  el.addEventListener("pointermove", onResizePointerMove);
  el.addEventListener("pointerup", onResizePointerEnd);
  el.addEventListener("pointercancel", onResizePointerEnd);
  el.addEventListener("keydown", onResizeKeydown);
  // The handle sits over the sidebar's right edge but is a host SIBLING, so
  // moving the pointer from the sidebar onto it fires the sidebar's
  // pointerleave (arming the hover-close) without any sidebar-child re-entry to
  // cancel it — a pause while aiming for the grab would then close the sidebar
  // mid-reach. Mirror the sidebar's own enter/leave pair here so the handle is a
  // seamless extension of the hover region: entering cancels the armed close;
  // leaving it (to the editor, not back into the sidebar) re-arms one, so
  // hover-to-close still works. scheduleClose no-ops mid-drag (the resizing
  // guard), and pointer capture suppresses these boundary events during a drag.
  el.addEventListener("pointerenter", () => deps.cancelScheduledClose());
  el.addEventListener("pointerleave", () => deps.scheduleClose());
  // The handle lives on the host, not the sidebar, but belongs to the same
  // outline focus region: bind focusout here too so tabbing from the handle to
  // an element outside the sidebar/handle dismisses the transient overlay (the
  // shared onSidebarFocusOut exempts focus moving BACK to the sidebar or handle).
  // Without this, a keyboard user focused on the handle has no focus-out path to
  // close a non-pinned overlay — the A11Y-03 obscured-focus wart would recur.
  el.addEventListener("focusout", (e) => deps.onFocusOut(e));

  // Restore a persisted width before first paint (guarded + in-range only:
  // a corrupt / out-of-range value falls through to the stylesheet default).
  const persisted = readPersistedState()[WIDTH_STATE_KEY];
  if (typeof persisted === "number" && Number.isFinite(persisted)) {
    if (clampWidth(persisted) === persisted) {
      host.style.setProperty("--quoll-outline-sidebar-width", `${persisted}px`);
    }
  }
  // Seed aria-valuenow AFTER the persisted restore so AT reads the effective
  // width (restored value or the stylesheet default), not a stale placeholder.
  updateResizeAria();

  return {
    el,
    isResizing: () => resizing,
    destroy(): void {
      endResize(); // persist an in-flight drag before teardown (no-op if idle)
      el.remove(); // drops its pointer listeners with it
    },
  };
}
