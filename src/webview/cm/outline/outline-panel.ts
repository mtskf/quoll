// Document outline sidebar — a webview-native ViewPlugin that renders the
// top-left toggle button + a left-edge slide-in sidebar inside the
// .quoll-editor host. Hovering the toggle opens the sidebar; the pointer
// leaving it (grace-delayed), a heading jump, or Mod-Alt-o closes it — unless
// PINNED via the header pin button. Pinned mode swaps the absolute overlay for
// a static 2-column flex layout. CSS owns ALL geometry off two host classes
// (quoll-outline-open / quoll-outline-pinned); this module owns state + DOM.
// Individual headings with children collapse their own subtree via per-row
// twisties (no whole-section fold — the OUTLINE header is a static label).
// Keyboard model (WAI-ARIA tree-view): each row IS the focusable treeitem with a
// roving tabindex (one tab stop for the whole tree); Up/Down/Home/End move focus,
// Left/Right collapse/expand or climb/dive, Enter jumps. The twistie is an
// aria-hidden decorative chevron — a pointer affordance only, not a tab stop.
// View-only: clicking a heading dispatches a SELECTION-ONLY transaction (no
// `changes`), so the round-trip is byte-identical and no Edit is posted. All
// rebuild work is gated on the sidebar being open AND debounced, so the
// keystroke path pays nothing while closed and only an amortised cost while
// open. Colours come from --vscode-* vars + the --quoll-outline-sidebar-*
// tokens (styles.css) so dark / light / high-contrast track.
//
// Responsibility split: this module owns the *policy* — WHEN to rebuild
// (open = immediate + one forced complete parse; edits = debounced, cheap
// syntaxTree) and the DOM. build-outline.ts is the pure extraction given a
// tree; icons.ts owns the Lucide SVG subtrees.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { patchPersistedState, readPersistedState } from "../../host.js";
import { requireQuollEditorHost } from "../editor-host.js";
import { DEFAULT_EDITOR_PREFS, editorPrefsField } from "../editor-prefs.js";
import { extractOutline, type OutlineHeading } from "./build-outline.js";
import { createChevronIcon, createMenuIcon, createPinIcon, createSettingsIcon } from "./icons.js";
import { createSettingsPopover, type SettingsPopover } from "./settings-popover.js";
import { quollUpdateConfigSink } from "./update-config-sink.js";

/** Toggle chord. CM-scoped (fires only while the editor has focus), so it never
 *  collides with a workbench keybinding — same posture as the context-handoff /
 *  lint-fix chords. `Mod-Alt-o` is unused by the other Quoll keymaps. */
const TOGGLE_KEY = "Mod-Alt-o";

/** Per-depth indent step (px) and the list's base left padding (px). The base
 *  matches the OUTLINE header's 12px left inset (padding-left) so a first-level
 *  (depth 0) row lines up under the header's left edge — the chevron/twistie
 *  column — the way VS Code aligns side-panel tree rows under their section
 *  twistie (the "OUTLINE" label itself sits further right, past the chevron). */
const INDENT_PX = 12;
const BASE_PAD_PX = 12;

/** Trailing debounce for edit-driven rebuilds — keeps the full tree walk off
 *  the per-keystroke path while the sidebar is open. */
const REBUILD_DEBOUNCE_MS = 200;

/** Ceiling (ms) for the ONE forced complete parse on the deliberate open. A
 *  ceiling, not a wait: an already-parsed live view returns instantly. Only a
 *  pathological multi-MB document not yet parsed to its end can hit it, in which
 *  case `ensureSyntaxTree` returns null and we fall back to the partial
 *  `syntaxTree` (best-effort, filled in on scroll by the update() tree-identity
 *  check). Edit-driven refreshes never force a parse — they read syntaxTree. */
const PARSE_BUDGET_MS = 500;

/** Grace (ms) between the pointer leaving the OPEN sidebar and the actual
 *  close — short enough that the overlay never feels sticky. Re-entering the
 *  sidebar cancels it. Only the sidebar's own pointerleave arms this (the
 *  toggle's leave never does — see the constructor's flicker note). */
const HOVER_CLOSE_DELAY_MS = 150;

/** Hover-intent (ms) before a pointerenter on the toggle actually opens. A
 *  pointer merely grazing the top-left corner neither flashes the sidebar nor
 *  pays the open-time forced parse (ensureSyntaxTree, up to PARSE_BUDGET_MS).
 *  Deliberate opens (click / Mod-Alt-o) skip it. */
const HOVER_OPEN_DELAY_MS = 120;

/** Host classes CSS keys ALL open/pinned geometry off. Exported for tests. */
export const OUTLINE_OPEN_CLASS = "quoll-outline-open";
export const OUTLINE_PINNED_CLASS = "quoll-outline-pinned";

/** Runtime-resizable sidebar width bounds (px). The stylesheet default
 *  (--quoll-outline-sidebar-width: 260px) applies until the user drags; a drag
 *  overrides the var inline on the host and persists the value. This clamp
 *  bounds the STORED width at drag/restore time; styles.css additionally caps
 *  the LIVE display at min(var, 80%) of the host (re-evaluated on layout, for
 *  host-shrink) using the SAME expression on the sidebar and the handle so they
 *  never desync. The two are complementary — both keep the editor column alive. */
const MIN_WIDTH_PX = 180;
const MAX_WIDTH_PX = 600;
/** Persisted view-state key (flat, survives reload) — see readPersistedState.
 *  Flat + namespaced by name so it shallow-merges alongside any future keys
 *  without a nested schema (one key today). */
const WIDTH_STATE_KEY = "outlineWidthPx";

/** A rendered outline row + its structural facts, for post-render visibility
 *  updates that never rebuild the DOM (collapse toggles reuse these refs). The
 *  `li` IS the focusable tree node (roving tabindex); the twistie is an
 *  aria-hidden decorative chevron and the item span is display-only. */
interface RowRef {
  heading: OutlineHeading;
  hasChildren: boolean;
  li: HTMLLIElement;
  twistie: HTMLSpanElement | null;
}

class OutlinePanel implements PluginValue {
  private readonly host: HTMLElement;
  private readonly toggleEl: HTMLButtonElement;
  private readonly sidebarEl: HTMLElement;
  private readonly pinEl: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private readonly resizeEl: HTMLElement;
  private readonly settingsToggleEl: HTMLButtonElement;
  private readonly footerEl: HTMLElement;
  /** The mounted settings popover, or null while closed. Its presence IS the
   *  open state — no separate boolean can diverge from the DOM. */
  private settingsPopover: SettingsPopover | null = null;
  /** Capturing document pointerdown listener installed while the popover is open
   *  (click-outside close); removed by closeSettings. */
  private onDocPointerDown: ((e: Event) => void) | null = null;
  private resizing = false;
  /** The pointerId that started the active drag; guards against a second
   *  pointer's events hijacking the resize. */
  private resizePointerId: number | null = null;
  /** True once a pointermove actually changed the width during this drag. Only
   *  a moved drag persists — a click-without-drag (pointerdown→up, no move)
   *  must not fire a redundant setState. */
  private resizeMoved = false;
  private open = false;
  /** Invariant: pinned ⇒ open (closing by any path unpins). */
  private pinned = false;
  private headings: OutlineHeading[] = [];
  /** Session-local per-heading collapse: `from` offsets of collapsed headings.
   *  Positional identity (`from`) per build-outline's contract — session-local &
   *  never persisted (no protocol / storage). Pruned on each rebuild to parent
   *  headings that still exist, so it never grows unbounded. */
  private readonly collapsedFroms = new Set<number>();
  /** Rendered rows for post-render visibility refresh (see refreshVisibility). */
  private rows: RowRef[] = [];
  /** `from` of the row that currently holds `tabindex="0"` — the single tab stop
   *  into the tree (roving tabindex). All other visible rows are `tabindex="-1"`,
   *  reachable only via the arrow-key handlers. Null while the list is empty. */
  private tabbableFrom: number | null = null;
  /** Signature of the last rendered list; null forces the first render. */
  private renderedSignature: string | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {
    // In production the EditorView is mounted inside the `.quoll-editor` host,
    // which is the sidebar's positioned ancestor (styles.css sets
    // position: relative on it). Fail fast rather than attaching the overlay
    // into CodeMirror's own managed DOM (view.dom) if that host is missing.
    const host = requireQuollEditorHost(view, "quollOutline");
    this.host = host;

    this.toggleEl = document.createElement("button");
    this.toggleEl.type = "button";
    this.toggleEl.className = "quoll-outline-toggle";
    this.toggleEl.title = "Show document outline (Ctrl/Cmd+Alt+O)";
    this.toggleEl.setAttribute("aria-label", "Show document outline");
    this.toggleEl.setAttribute("aria-pressed", "false");
    this.toggleEl.appendChild(createMenuIcon());
    // preventDefault on mousedown so clicking the button does not blur/move the
    // editor selection before we act; focus is managed explicitly on jump.
    this.toggleEl.addEventListener("mousedown", (e) => e.preventDefault());
    // Click OPENS (idempotent), it does not toggle: while open the toggle is
    // pointer-invisible (open-state CSS), so a real click-to-close can never
    // happen — a toggle here would only manifest as a keyboard/AT surprise.
    // Closing paths: pointer-leave grace, jump, Escape, Mod-Alt-o.
    this.toggleEl.addEventListener("click", (e) => {
      e.preventDefault();
      this.setOpen(true);
    });
    // Hover-open with intent delay: entering the toggle arms the open; leaving
    // before it fires disarms it (grazing pointers never open). The toggle's
    // leave deliberately does NOT schedule a close: at open time this button
    // goes pointer-events:none under a possibly-stationary pointer, and the
    // browser's async hover recompute fires its leave BEFORE the sliding
    // sidebar arrives to cancel — a close/reopen flicker loop. Once open,
    // closing belongs to the sidebar's pointerleave / jump / Escape / keymap.
    this.toggleEl.addEventListener("pointerenter", () => {
      this.cancelScheduledClose();
      this.scheduleOpen();
    });
    this.toggleEl.addEventListener("pointerleave", () => this.cancelScheduledOpen());

    this.sidebarEl = document.createElement("div");
    this.sidebarEl.className = "quoll-outline-sidebar";
    // Closed = slid off-screen but still rendered (the slide transition needs a
    // live element). `inert` drops the hidden sidebar from the focus + a11y
    // tree immediately — the CSS visibility flip is delayed until the slide-out
    // finishes. Same posture as the scroll-hide chrome.
    this.sidebarEl.toggleAttribute("inert", true);
    this.sidebarEl.addEventListener("pointerenter", () => this.cancelScheduledClose());
    this.sidebarEl.addEventListener("pointerleave", () => this.scheduleClose());
    // Escape = explicit keyboard close (and unpin, via the setOpen invariant).
    // This is the close affordance for keyboard-driven opens, which have no
    // pointer to leave with; focus is handed back to the editor by setOpen.
    this.sidebarEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.setOpen(false);
      }
    });

    const header = document.createElement("div");
    header.className = "quoll-outline-header";
    this.pinEl = document.createElement("button");
    this.pinEl.type = "button";
    this.pinEl.className = "quoll-outline-pin";
    this.pinEl.title = "Pin outline sidebar";
    this.pinEl.setAttribute("aria-label", "Pin outline sidebar");
    this.pinEl.setAttribute("aria-pressed", "false");
    this.pinEl.appendChild(createPinIcon());
    this.pinEl.addEventListener("mousedown", (e) => e.preventDefault());
    this.pinEl.addEventListener("click", (e) => {
      e.preventDefault();
      this.setPinned(!this.pinned);
    });
    // Static "OUTLINE" section label — a plain, non-interactive title (the panel
    // itself has no whole-section fold; only per-heading twisties collapse
    // subtrees). Title leads, pin trails: matches VS Code side-panel header order
    // (title left, action button right). The pin is pushed to the right edge by
    // margin-left:auto (styles.css).
    const titleEl = document.createElement("span");
    titleEl.className = "quoll-outline-title";
    titleEl.textContent = "Outline";
    header.appendChild(titleEl);
    header.appendChild(this.pinEl);

    this.listEl = document.createElement("ul");
    this.listEl.className = "quoll-outline-list";
    // Expose the outline as an ARIA tree. The DOM is a FLAT <ul> of rows (no
    // nested <ul role="group">), so nesting is conveyed by per-row aria-level
    // rather than DOM structure — the spec-sanctioned flat-tree model. The tree
    // needs an accessible name of its own (the visual "Outline" title is a plain
    // span, not associated).
    this.listEl.setAttribute("role", "tree");
    this.listEl.setAttribute("aria-label", "Document outline");
    // Keyboard tree model (WAI-ARIA tree-view pattern): one delegated handler on
    // the list — focus lives on a row <li> (roving tabindex), so every arrow /
    // Home / End / Enter keydown bubbles here. Delegation survives every rebuild
    // (the list element persists; only its rows are replaced).
    this.listEl.addEventListener("keydown", (e) => this.onListKeydown(e));

    const footer = document.createElement("div");
    footer.className = "quoll-outline-footer";
    const settingsEl = document.createElement("button");
    settingsEl.type = "button";
    settingsEl.className = "quoll-outline-settings";
    settingsEl.title = "Editor settings";
    settingsEl.setAttribute("aria-label", "Editor settings");
    settingsEl.setAttribute("aria-haspopup", "dialog");
    settingsEl.setAttribute("aria-expanded", "false");
    settingsEl.appendChild(createSettingsIcon());
    const settingsLabel = document.createElement("span");
    settingsLabel.textContent = "Settings";
    settingsEl.appendChild(settingsLabel);
    settingsEl.addEventListener("mousedown", (e) => e.preventDefault());
    settingsEl.addEventListener("click", (e) => {
      e.preventDefault();
      this.toggleSettings();
    });
    this.settingsToggleEl = settingsEl;
    footer.appendChild(settingsEl);
    this.footerEl = footer;

    this.sidebarEl.appendChild(header);
    this.sidebarEl.appendChild(this.listEl);
    this.sidebarEl.appendChild(footer);

    // Sidebar FIRST in DOM order (before CodeMirror's element) so the pinned
    // flex row reads sidebar-then-editor without `order` tricks, and the tab /
    // a11y order matches the visual left-to-right order.
    this.host.insertBefore(this.sidebarEl, this.host.firstChild);
    this.host.appendChild(this.toggleEl);

    // Resize handle: a host child (not a sidebar child) pinned to the sidebar's
    // right edge via `left: var(--quoll-outline-sidebar-width)`. Dragging it
    // rewrites that var inline on the host, which moves the sidebar edge, the
    // pinned flex-basis, AND the handle together — one source of truth for the
    // runtime width. Only interactive while the sidebar is open (CSS gates it).
    // Listeners live on the handle + pointer capture, so a release outside the
    // iframe still ends the drag (pointerup/pointercancel), and remove() cleans
    // them up.
    this.resizeEl = document.createElement("div");
    this.resizeEl.className = "quoll-outline-resize-handle";
    this.resizeEl.setAttribute("aria-hidden", "true"); // pointer affordance; keyboard resize is a follow-up
    this.resizeEl.addEventListener("pointerdown", (e) => this.onResizePointerDown(e));
    this.resizeEl.addEventListener("pointermove", (e) => this.onResizePointerMove(e));
    this.resizeEl.addEventListener("pointerup", (e) => this.onResizePointerEnd(e));
    this.resizeEl.addEventListener("pointercancel", (e) => this.onResizePointerEnd(e));
    this.host.appendChild(this.resizeEl);

    // Restore a persisted width before first paint (guarded + in-range only:
    // a corrupt / out-of-range value falls through to the stylesheet default).
    const persisted = readPersistedState()[WIDTH_STATE_KEY];
    if (typeof persisted === "number" && Number.isFinite(persisted)) {
      if (this.clampWidth(persisted) === persisted) {
        this.host.style.setProperty("--quoll-outline-sidebar-width", `${persisted}px`);
      }
    }
  }

  update(u: ViewUpdate): void {
    // Sync the settings popover on ANY editorPrefsField change (host echo). This
    // runs BEFORE the open-gated early-return: a same-value re-push (override /
    // host-failure branch) carries a FRESH prefs object so field identity
    // changes even when the value is unchanged — that is precisely the signal
    // that clears the popover's pending row. Guarded on popover existence.
    if (
      this.settingsPopover !== null &&
      u.startState.field(editorPrefsField, false) !== u.state.field(editorPrefsField, false)
    ) {
      this.settingsPopover.syncFromState();
    }
    // Map per-heading collapse offsets through document edits so a collapsed
    // heading stays collapsed when text shifts it — and its state never lands on
    // an unrelated heading inserted at the old offset (assoc +1: an insertion at
    // the heading's line start moves the offset to AFTER the inserted text, i.e.
    // it follows the heading, not the new content). Runs regardless of open
    // state: collapse survives a close, so edits made while closed must map too.
    // The subsequent rebuild's live-parent prune then drops offsets whose
    // heading was actually deleted.
    if (u.docChanged && this.collapsedFroms.size > 0) {
      const mapped = new Set<number>();
      for (const from of this.collapsedFroms) {
        mapped.add(u.changes.mapPos(from, 1));
      }
      this.collapsedFroms.clear();
      for (const from of mapped) {
        this.collapsedFroms.add(from);
      }
    }
    if (!this.open) {
      return;
    }
    // Rebuild on doc change OR on a syntax-tree identity change (the background
    // parser advancing over a large document fires an update with docChanged
    // false — catching it keeps the outline complete without user input).
    if (u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.scheduleRebuild();
    } else if (u.selectionSet) {
      this.updateActive();
    }
  }

  destroy(): void {
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
    }
    this.cancelScheduledClose();
    this.cancelScheduledOpen();
    this.closeSettings(); // unmount the popover + drop its document listener
    this.endResize(); // persist an in-flight drag before teardown (no-op if idle)
    this.toggleEl.remove();
    this.sidebarEl.remove();
    this.resizeEl.remove(); // drops its pointer listeners with it
    // Clear the host flags so a lingering host node (tests, re-mount) never
    // inherits a stale open/pinned layout — mirrors FloatingToolbarScroll's
    // destroy hygiene.
    this.host.classList.remove(OUTLINE_OPEN_CLASS, OUTLINE_PINNED_CLASS);
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  private toggleSettings(): void {
    if (this.settingsPopover !== null) {
      this.closeSettings();
    } else {
      this.openSettings();
    }
  }

  private openSettings(): void {
    if (this.settingsPopover !== null) {
      return;
    }
    const popover = createSettingsPopover({
      getPrefs: () => this.view.state.field(editorPrefsField, false) ?? DEFAULT_EDITOR_PREFS,
      onChange: (key, value) => this.view.state.facet(quollUpdateConfigSink)(key, value),
      // Escape inside the popover delegates here — closeSettings is the SOLE
      // unmount path (removes el, resets aria-expanded, drops the pointerdown
      // listener), so the popover never half-closes itself.
      onRequestClose: () => this.closeSettings(),
    });
    this.settingsPopover = popover;
    this.footerEl.appendChild(popover.el); // footer is position:relative (styles.css)
    // The popover synced its active state at construction; no open() call.
    this.settingsToggleEl.setAttribute("aria-expanded", "true");
    // Click-outside: a pointerdown outside the popover AND not on the gear closes
    // it. Ignoring the gear prevents the pointerdown→close then click→reopen flap.
    this.onDocPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (
        target !== null &&
        (popover.el.contains(target) || this.settingsToggleEl.contains(target))
      ) {
        return;
      }
      this.closeSettings();
    };
    this.view.dom.ownerDocument.addEventListener("pointerdown", this.onDocPointerDown, true);
  }

  private closeSettings(): void {
    if (this.settingsPopover === null) {
      return;
    }
    if (this.onDocPointerDown !== null) {
      this.view.dom.ownerDocument.removeEventListener("pointerdown", this.onDocPointerDown, true);
      this.onDocPointerDown = null;
    }
    this.settingsPopover.destroy();
    this.settingsPopover = null;
    this.settingsToggleEl.setAttribute("aria-expanded", "false");
  }

  private setOpen(open: boolean): void {
    // Re-entering the toggle while already open must cancel a pending
    // hover-close — so cancel BEFORE the idempotence early-return. A
    // deliberate open/close also supersedes any armed hover-intent.
    this.cancelScheduledClose();
    this.cancelScheduledOpen();
    if (open === this.open) {
      return;
    }
    this.open = open;
    // Capture BEFORE mutating: setting `inert` below can make the browser
    // evict focus from the sidebar synchronously, so an after-the-fact
    // activeElement check would miss it and strand focus on <body>.
    const hadSidebarFocus = this.sidebarEl.contains(document.activeElement);
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (!open) {
      // Closing the sidebar closes the settings popover too (it lives in the
      // footer; a lingering popover over a closed sidebar has no meaning).
      this.closeSettings();
    }
    if (!open && this.pinned) {
      // Invariant: pinned ⇒ open. An explicit close (toggle / Mod-Alt-o)
      // unpins too — a pinned-but-closed host combo has no CSS meaning.
      this.setPinned(false);
    }
    this.host.classList.toggle(OUTLINE_OPEN_CLASS, open);
    this.sidebarEl.toggleAttribute("inert", !open);
    this.toggleEl.setAttribute("aria-pressed", String(open));
    this.toggleEl.classList.toggle("active", open);
    if (open) {
      // The open-state CSS hides the toggle (the header pin takes its spot); a
      // keyboard-focused toggle would strand focus on an invisible control.
      if (document.activeElement === this.toggleEl) {
        this.pinEl.focus();
      }
      // Opening is a deliberate action — rebuild immediately AND force a
      // complete parse so the WHOLE document's headings appear, not just the
      // parsed viewport. The only forced parse; off the keystroke path.
      this.rebuild(true);
    } else if (hadSidebarFocus) {
      // Closing while focus was inside the (now-inert) sidebar: hand focus
      // back to the editor instead of letting the browser drop it on <body>.
      this.view.focus();
    }
  }

  private setPinned(pinned: boolean): void {
    // Invariant: pinned ⇒ open. Pinning a closed sidebar opens it first, so the
    // guarantee holds at every mutation point — not just via setOpen's close path.
    if (pinned && !this.open) {
      this.setOpen(true);
    }
    this.pinned = pinned;
    this.host.classList.toggle(OUTLINE_PINNED_CLASS, pinned);
    this.pinEl.classList.toggle("pinned", pinned);
    this.pinEl.setAttribute("aria-pressed", String(pinned));
    if (pinned) {
      this.cancelScheduledClose();
    }
    // Unpinning deliberately KEEPS the sidebar open: a pointer-driven unpin
    // happens with the pointer inside the sidebar, so the normal pointer-leave
    // path closes it afterwards; a keyboard unpin never surprise-closes a
    // surface the user is focused in.
  }

  private scheduleOpen(): void {
    if (this.open) {
      return;
    }
    this.cancelScheduledOpen();
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      this.setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  }

  private cancelScheduledOpen(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }

  private clampWidth(px: number): number {
    // happy-dom / pre-layout: clientWidth 0 ⇒ no viewport bound yet, use the
    // absolute ceiling. In a real browser, also cap at 80% of the host width so
    // the editor column survives at drag/restore time. styles.css re-applies the
    // same 80%-of-host cap live via min(var, 80%) for later host shrinks; the two
    // caps agree, so a value this clamp passes is never re-capped on a stable host.
    const hostWidth = this.host.clientWidth;
    const upper = hostWidth > 0 ? Math.min(MAX_WIDTH_PX, hostWidth * 0.8) : MAX_WIDTH_PX;
    return Math.round(Math.max(MIN_WIDTH_PX, Math.min(upper, px)));
  }

  /** Set the width var from a pointer's clientX (relative to the host's left). */
  private applyResize(clientX: number): void {
    const width = this.clampWidth(clientX - this.host.getBoundingClientRect().left);
    this.host.style.setProperty("--quoll-outline-sidebar-width", `${width}px`);
  }

  private onResizePointerDown(e: PointerEvent): void {
    if (this.resizing) {
      return; // a second pointer must not hijack an active drag
    }
    e.preventDefault();
    this.resizing = true;
    this.resizeMoved = false;
    this.resizePointerId = e.pointerId;
    // Route subsequent moves/up to the handle even outside the iframe. Guarded:
    // happy-dom has no setPointerCapture.
    this.resizeEl.setPointerCapture?.(e.pointerId);
    // Dragging in overlay mode moves the pointer out of the sidebar — cancel any
    // armed hover-close so the surface can't vanish mid-drag (scheduleClose also
    // early-returns while resizing).
    this.cancelScheduledClose();
  }

  private onResizePointerMove(e: PointerEvent): void {
    if (!this.resizing || e.pointerId !== this.resizePointerId) {
      return;
    }
    this.resizeMoved = true;
    this.applyResize(e.clientX);
  }

  /** Unified drag-end for pointerup AND pointercancel. */
  private onResizePointerEnd(e: PointerEvent): void {
    if (!this.resizing || e.pointerId !== this.resizePointerId) {
      return;
    }
    // pointercancel carries no useful clientX — only apply on pointerup.
    if (e.type === "pointerup") {
      this.applyResize(e.clientX);
    }
    this.endResize();
  }

  /** Stop the drag and persist the committed width. Idempotent + shared by the
   *  pointer-end path and destroy-mid-drag. Only a drag that actually moved
   *  persists — a click-without-drag fires no redundant setState. */
  private endResize(): void {
    if (!this.resizing) {
      return;
    }
    this.resizing = false;
    if (this.resizePointerId !== null) {
      this.resizeEl.releasePointerCapture?.(this.resizePointerId);
      this.resizePointerId = null;
    }
    if (!this.resizeMoved) {
      return; // no movement ⇒ no new width to persist
    }
    this.resizeMoved = false;
    const width = Number.parseInt(
      this.host.style.getPropertyValue("--quoll-outline-sidebar-width"),
      10
    );
    if (Number.isFinite(width)) {
      patchPersistedState({ [WIDTH_STATE_KEY]: width });
    }
  }

  private scheduleClose(): void {
    if (this.pinned || !this.open || this.resizing) {
      return;
    }
    this.cancelScheduledClose();
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!this.pinned) {
        this.setOpen(false);
      }
    }, HOVER_CLOSE_DELAY_MS);
  }

  private cancelScheduledClose(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.open) {
        this.rebuild(false); // cheap: post-open the tree stays complete
      }
    }, REBUILD_DEBOUNCE_MS);
  }

  private rebuild(forceComplete: boolean): void {
    const state = this.view.state;
    // Tree source by path: the deliberate OPEN forces a complete parse
    // (ensureSyntaxTree, bounded by PARSE_BUDGET_MS) so the WHOLE document's
    // headings appear — CodeMirror's background parser only guarantees the
    // viewport (+~100 KB), so a plain syntaxTree would silently drop headings
    // far below the fold. Edit-driven refreshes read the cheap already-parsed
    // syntaxTree (kept complete by the open parse + incremental parsing) — never
    // a forced parse on the keystroke-adjacent path. A doc whose parse exceeds
    // the open budget falls back to best-effort syntaxTree, filled in on scroll
    // by the update() tree-identity check.
    const tree = forceComplete
      ? (ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state))
      : syntaxTree(state);
    this.headings = extractOutline(state, tree);
    const signature = this.headings.map((h) => `${h.from}:${h.level}:${h.text}`).join("\n");
    if (signature !== this.renderedSignature) {
      this.renderedSignature = signature;
      this.renderList();
    }
    this.updateActive();
  }

  private renderList(): void {
    this.listEl.textContent = "";
    this.rows = [];
    if (this.headings.length === 0) {
      const empty = document.createElement("li");
      empty.className = "quoll-outline-empty";
      // Not a tree node — neutralise the implicit listitem role so the empty
      // message never masquerades as a treeitem inside role="tree".
      empty.setAttribute("role", "none");
      empty.textContent = "No headings";
      this.listEl.appendChild(empty);
      return;
    }
    const hasChildren = this.computeHasChildren();
    // Prune stale collapse entries: keep only froms that are still a parent
    // heading, so the set tracks the live document and never grows unbounded.
    const liveParents = new Set(this.headings.filter((_, i) => hasChildren[i]).map((h) => h.from));
    for (const from of [...this.collapsedFroms]) {
      if (!liveParents.has(from)) {
        this.collapsedFroms.delete(from);
      }
    }
    this.headings.forEach((heading, i) => {
      const li = document.createElement("li");
      li.className = "quoll-outline-row";
      // The row IS the tree node. aria-level is 1-based off the 0-based render
      // depth, so it tracks the visual indentation (a skipped heading level,
      // e.g. h1→h3, collapses to contiguous depth — the tree nesting the reader
      // perceives). aria-expanded (parents only) + aria-selected are set by
      // refreshVisibility / updateActive.
      li.setAttribute("role", "treeitem");
      li.setAttribute("aria-level", String(heading.depth + 1));
      // Depth indent rides the row; the twistie column is a fixed inset inside it.
      li.style.paddingLeft = `${BASE_PAD_PX + heading.depth * INDENT_PX}px`;
      // The row is the single focusable tree node. Roving tabindex: setTabbable
      // promotes exactly one row to 0; everyone starts at -1. Clicking the row
      // (label included) jumps; mousedown preventDefault keeps the editor
      // selection put until the jump dispatch runs.
      li.tabIndex = -1;
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => this.jumpTo(heading));

      let twistie: HTMLSpanElement | null = null;
      if (hasChildren[i]) {
        // Decorative chevron — aria-hidden, no tabindex, NOT a tab stop. The row
        // owns the expand/collapse semantics (aria-expanded + Left/Right keys);
        // this stays clickable purely as a pointer affordance. stopPropagation so
        // a twistie click toggles collapse without also firing the row's jump.
        twistie = document.createElement("span");
        twistie.className = "quoll-outline-twistie";
        twistie.setAttribute("aria-hidden", "true");
        twistie.appendChild(createChevronIcon());
        twistie.addEventListener("mousedown", (e) => e.preventDefault());
        twistie.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleCollapse(heading.from);
        });
        li.appendChild(twistie);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "quoll-outline-twistie-spacer";
        spacer.setAttribute("aria-hidden", "true");
        li.appendChild(spacer);
      }

      const label = document.createElement("span");
      label.className = `quoll-outline-item level-${heading.level}`;
      label.textContent = heading.text.length > 0 ? heading.text : "(untitled)";
      label.dataset.from = String(heading.from);
      li.appendChild(label);

      this.listEl.appendChild(li);
      this.rows.push({ heading, hasChildren: hasChildren[i], li, twistie });
    });
    this.refreshVisibility();
    // Seed the roving tab stop at the first visible row; updateActive (called
    // right after in rebuild) re-homes it onto the caret's heading when the list
    // is not focused, so Tab enters the tree at the current location.
    this.setTabbable(this.firstVisibleFrom());
  }

  /** hasChildren[i] ⇔ the next heading is deeper (its subtree starts under i). */
  private computeHasChildren(): boolean[] {
    return this.headings.map((h, i) => {
      const next = this.headings[i + 1];
      return next !== undefined && next.depth > h.depth;
    });
  }

  /** Flip a heading's collapse state, then re-hide/reveal + re-sync active. */
  private toggleCollapse(from: number): void {
    if (this.collapsedFroms.has(from)) {
      this.collapsedFroms.delete(from);
    } else {
      this.collapsedFroms.add(from);
    }
    this.refreshVisibility();
    // A collapse can hide the row that held the tab stop (e.g. a pointer collapse
    // of an ancestor while a descendant was tabbable) — re-home it so the tree
    // never keeps its only tab stop on a `display:none` row.
    this.ensureTabbableVisible();
    this.updateActive();
  }

  // ── Roving tabindex + keyboard tree navigation (WAI-ARIA tree-view) ──────────

  /** `from` of the first visible row, or null when none are visible. */
  private firstVisibleFrom(): number | null {
    const row = this.rows.find((r) => !r.li.hidden);
    return row !== undefined ? row.heading.from : null;
  }

  /** Promote exactly one row to `tabindex="0"` (the sole tab stop into the tree);
   *  demote the rest to `-1`. Null clears every row to `-1` (empty list). */
  private setTabbable(from: number | null): void {
    this.tabbableFrom = from;
    for (const row of this.rows) {
      row.li.tabIndex = row.heading.from === from ? 0 : -1;
    }
  }

  /** If the tab stop landed on a now-hidden (or removed) row, move it to the
   *  first visible row so Tab always reaches a real, visible node. */
  private ensureTabbableVisible(): void {
    if (this.tabbableFrom === null) {
      return;
    }
    const row = this.rows.find((r) => r.heading.from === this.tabbableFrom);
    if (row === undefined || row.li.hidden) {
      this.setTabbable(this.firstVisibleFrom());
    }
  }

  /** Move the tab stop to a row and focus it — the shared move for every
   *  arrow-key / Home / End navigation. */
  private focusRow(row: RowRef): void {
    this.setTabbable(row.heading.from);
    row.li.focus();
  }

  /** Focus the nearest visible row in `dir` from `idx` (no wrap). */
  private focusRelative(idx: number, dir: 1 | -1): void {
    for (let i = idx + dir; i >= 0 && i < this.rows.length; i += dir) {
      if (!this.rows[i].li.hidden) {
        this.focusRow(this.rows[i]);
        return;
      }
    }
  }

  private onListKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const li = target?.closest<HTMLLIElement>(".quoll-outline-row") ?? null;
    if (li === null) {
      return;
    }
    const idx = this.rows.findIndex((r) => r.li === li);
    if (idx === -1) {
      return;
    }
    const row = this.rows[idx];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.focusRelative(idx, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.focusRelative(idx, -1);
        break;
      case "Home": {
        e.preventDefault();
        const first = this.rows.find((r) => !r.li.hidden);
        if (first !== undefined) {
          this.focusRow(first);
        }
        break;
      }
      case "End": {
        e.preventDefault();
        for (let i = this.rows.length - 1; i >= 0; i--) {
          if (!this.rows[i].li.hidden) {
            this.focusRow(this.rows[i]);
            break;
          }
        }
        break;
      }
      case "ArrowRight":
        e.preventDefault();
        this.onArrowRight(idx, row);
        break;
      case "ArrowLeft":
        e.preventDefault();
        this.onArrowLeft(idx, row);
        break;
      case "Enter":
        e.preventDefault();
        this.jumpTo(row.heading);
        break;
      default:
        // Everything else (incl. Escape, handled by the sidebar) bubbles on.
        break;
    }
  }

  /** Right: expand a collapsed parent (focus stays); on an already-expanded
   *  parent, dive to the first child; a leaf does nothing. */
  private onArrowRight(idx: number, row: RowRef): void {
    if (!row.hasChildren) {
      return;
    }
    if (this.collapsedFroms.has(row.heading.from)) {
      this.toggleCollapse(row.heading.from); // expand in place
      this.focusRow(row); // re-assert the tab stop / focus on this row
    } else {
      // Expanded ⇒ the next row is this parent's first child (build order).
      this.focusRelative(idx, 1);
    }
  }

  /** Left: collapse an expanded parent (focus stays); otherwise climb to the
   *  parent row (nearest shallower visible ancestor). */
  private onArrowLeft(idx: number, row: RowRef): void {
    if (row.hasChildren && !this.collapsedFroms.has(row.heading.from)) {
      this.toggleCollapse(row.heading.from); // collapse in place
      this.focusRow(row);
      return;
    }
    const depth = row.heading.depth;
    for (let i = idx - 1; i >= 0; i--) {
      if (!this.rows[i].li.hidden && this.rows[i].heading.depth < depth) {
        this.focusRow(this.rows[i]);
        return;
      }
    }
  }

  /** Walk the flat rows with a depth stack: any row deeper than the shallowest
   *  active collapsed ancestor is hidden. Syncs each twistie's aria state. No DOM
   *  rebuild — only li.hidden + aria flip, so it is cheap on every toggle. */
  private refreshVisibility(): void {
    let collapseDepth: number | null = null; // depth of the hiding ancestor, or null
    for (const row of this.rows) {
      const depth = row.heading.depth;
      if (collapseDepth !== null && depth <= collapseDepth) {
        collapseDepth = null; // exited the collapsed subtree
      }
      const hidden = collapseDepth !== null;
      row.li.hidden = hidden;
      const collapsed = this.collapsedFroms.has(row.heading.from);
      // Expand state belongs to the tree node, so aria-expanded lives on the
      // treeitem row (the single source of truth SRs read on the tree). The
      // twistie is an aria-hidden decorative chevron — its rotation is driven
      // purely by the row's aria-expanded in CSS, no per-element aria needed.
      if (row.hasChildren) {
        row.li.setAttribute("aria-expanded", String(!collapsed));
      }
      if (!hidden && collapsed && row.hasChildren) {
        collapseDepth = depth; // hide this row's descendants
      }
    }
  }

  private jumpTo(heading: OutlineHeading): void {
    const pos = Math.min(heading.from, this.view.state.doc.length);
    this.view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
    this.view.focus();
    this.updateActive();
    // Overlay mode is a transient navigator — the jump ends the task, so put
    // the surface away. Pinned mode is a persistent map: stay open.
    if (!this.pinned) {
      this.setOpen(false);
    }
  }

  private updateActive(): void {
    if (!this.open) {
      return;
    }
    const head = this.view.state.selection.main.head;
    let activeFrom: number | null = null;
    for (const heading of this.headings) {
      if (heading.from <= head) {
        activeFrom = heading.from;
      } else {
        break;
      }
    }
    // If the active heading's row is hidden (inside a collapsed subtree), walk up
    // to the nearest VISIBLE ancestor so the highlight never lands on a hidden
    // row — we keep the nearest visible ancestor lit rather than auto-expanding
    // (auto-expand would undo a deliberate collapse on every caret move).
    if (activeFrom !== null) {
      const idx = this.rows.findIndex((r) => r.heading.from === activeFrom);
      if (idx !== -1 && this.rows[idx].li.hidden) {
        for (let i = idx - 1; i >= 0; i--) {
          if (!this.rows[i].li.hidden) {
            activeFrom = this.rows[i].heading.from;
            break;
          }
        }
      }
    }
    for (const item of this.listEl.querySelectorAll<HTMLElement>(".quoll-outline-item")) {
      const isActive = activeFrom !== null && item.dataset.from === String(activeFrom);
      item.classList.toggle("active", isActive);
      // The row li is the treeitem; the label span is its inner .active target.
      const rowLi = item.parentElement as HTMLElement | null;
      // aria-selected is the tree's selected-node signal — it rides the treeitem
      // (the row li), mirroring the visual .active on the inner label span.
      rowLi?.setAttribute("aria-selected", String(isActive));
      // Skip scroll for a hidden row (its parent li is collapsed away).
      if (isActive && rowLi?.hidden !== true) {
        item.scrollIntoView({ block: "nearest" });
      }
    }
    // Re-home the tab stop onto the caret's heading so Tab enters the tree at the
    // current location — but ONLY while focus is outside the list. Once the user
    // has tabbed in and is arrow-navigating, the keyboard owns the tab stop and a
    // caret-driven move must not yank it out from under them.
    if (!this.listEl.contains(document.activeElement)) {
      this.setTabbable(activeFrom ?? this.firstVisibleFrom());
    }
  }
}

/** Exported so the keymap and tests reach the instance via `view.plugin(...)`. */
export const outlinePlugin = ViewPlugin.fromClass(OutlinePanel);

const outlineKeymap = keymap.of([
  {
    key: TOGGLE_KEY,
    run: (view) => {
      const plugin = view.plugin(outlinePlugin);
      if (!plugin) {
        return false;
      }
      plugin.toggle();
      return true;
    },
  },
]);

/** The outline extension: the sidebar ViewPlugin + its toggle keymap. */
export function quollOutline(): Extension {
  return [outlinePlugin, outlineKeymap];
}
