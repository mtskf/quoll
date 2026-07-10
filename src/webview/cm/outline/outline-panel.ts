// Document outline sidebar — a webview-native ViewPlugin that renders the
// top-left toggle button + a left-edge slide-in sidebar inside the
// .quoll-editor host. Hovering the toggle opens the sidebar; the pointer
// leaving it (grace-delayed), a heading jump, or Mod-Alt-o closes it — unless
// PINNED via the header pin button. Pinned mode swaps the absolute overlay for
// a static 2-column flex layout. CSS owns ALL geometry off two host classes
// (quoll-outline-open / quoll-outline-pinned); this module owns state + DOM.
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
import { requireQuollEditorHost } from "../editor-host.js";
import { extractOutline, type OutlineHeading } from "./build-outline.js";
import { createPinIcon, createSettingsIcon } from "./icons.js";

/** Toggle chord. CM-scoped (fires only while the editor has focus), so it never
 *  collides with a workbench keybinding — same posture as the context-handoff /
 *  lint-fix chords. `Mod-Alt-o` is unused by the other Quoll keymaps. */
const TOGGLE_KEY = "Mod-Alt-o";

/** Per-depth indent step (px) and the list's base left padding (px). */
const INDENT_PX = 12;
const BASE_PAD_PX = 8;

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

class OutlinePanel implements PluginValue {
  private readonly host: HTMLElement;
  private readonly toggleEl: HTMLButtonElement;
  private readonly sidebarEl: HTMLElement;
  private readonly pinEl: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private open = false;
  /** Invariant: pinned ⇒ open (closing by any path unpins). */
  private pinned = false;
  private headings: OutlineHeading[] = [];
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
    this.toggleEl.textContent = "☰"; // ☰
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
    const titleEl = document.createElement("span");
    titleEl.className = "quoll-outline-title";
    titleEl.textContent = "Outline";
    header.appendChild(this.pinEl);
    header.appendChild(titleEl);

    this.listEl = document.createElement("ul");
    this.listEl.className = "quoll-outline-list";

    const footer = document.createElement("div");
    footer.className = "quoll-outline-footer";
    const settingsEl = document.createElement("button");
    settingsEl.type = "button";
    settingsEl.className = "quoll-outline-settings";
    settingsEl.title = "Settings";
    settingsEl.setAttribute("aria-label", "Settings");
    settingsEl.appendChild(createSettingsIcon());
    const settingsLabel = document.createElement("span");
    settingsLabel.textContent = "Settings";
    settingsEl.appendChild(settingsLabel);
    settingsEl.addEventListener("mousedown", (e) => e.preventDefault());
    // Deliberately a no-op today: the settings surface ships as a separate
    // task; the button pins the sidebar's final layout + affordance now.
    // aria-disabled (not `disabled`) keeps it visible and focusable while
    // telling AT the truth — REMOVE when the click handler lands.
    settingsEl.setAttribute("aria-disabled", "true");
    settingsEl.addEventListener("click", (e) => e.preventDefault());
    footer.appendChild(settingsEl);

    this.sidebarEl.appendChild(header);
    this.sidebarEl.appendChild(this.listEl);
    this.sidebarEl.appendChild(footer);

    // Sidebar FIRST in DOM order (before CodeMirror's element) so the pinned
    // flex row reads sidebar-then-editor without `order` tricks, and the tab /
    // a11y order matches the visual left-to-right order.
    this.host.insertBefore(this.sidebarEl, this.host.firstChild);
    this.host.appendChild(this.toggleEl);
  }

  update(u: ViewUpdate): void {
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
    this.toggleEl.remove();
    this.sidebarEl.remove();
    // Clear the host flags so a lingering host node (tests, re-mount) never
    // inherits a stale open/pinned layout — mirrors FloatingToolbarScroll's
    // destroy hygiene.
    this.host.classList.remove(OUTLINE_OPEN_CLASS, OUTLINE_PINNED_CLASS);
  }

  toggle(): void {
    this.setOpen(!this.open);
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

  private scheduleClose(): void {
    if (this.pinned || !this.open) {
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
    if (this.headings.length === 0) {
      const empty = document.createElement("li");
      empty.className = "quoll-outline-empty";
      empty.textContent = "No headings";
      this.listEl.appendChild(empty);
      return;
    }
    for (const heading of this.headings) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `quoll-outline-item level-${heading.level}`;
      btn.style.paddingLeft = `${BASE_PAD_PX + heading.depth * INDENT_PX}px`;
      btn.textContent = heading.text.length > 0 ? heading.text : "(untitled)";
      btn.dataset.from = String(heading.from);
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this.jumpTo(heading);
      });
      li.appendChild(btn);
      this.listEl.appendChild(li);
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
    for (const item of this.listEl.querySelectorAll<HTMLElement>(".quoll-outline-item")) {
      const isActive = activeFrom !== null && item.dataset.from === String(activeFrom);
      item.classList.toggle("active", isActive);
      if (isActive) {
        item.scrollIntoView({ block: "nearest" });
      }
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
