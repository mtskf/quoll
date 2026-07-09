// Document outline overlay — a webview-native ViewPlugin that renders a toggle
// button + a floating heading list inside the .quoll-editor host. View-only:
// clicking a heading dispatches a SELECTION-ONLY transaction (no `changes`), so
// the round-trip is byte-identical and no Edit is posted. All rebuild work is
// gated on the panel being open AND debounced, so the keystroke path pays
// nothing while closed and only an amortised cost while open. Colours come from
// --vscode-* CSS vars (styles.css) so dark / light / high-contrast track.
//
// Responsibility split (vs build-outline.ts): this module owns the *policy* —
// WHEN to rebuild (open = immediate + one forced complete parse; edits =
// debounced, cheap syntaxTree) and the DOM. build-outline.ts is the pure
// extraction given a tree.

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

/** Toggle chord. CM-scoped (fires only while the editor has focus), so it never
 *  collides with a workbench keybinding — same posture as the context-handoff /
 *  lint-fix chords. `Mod-Alt-o` is unused by the other Quoll keymaps. */
const TOGGLE_KEY = "Mod-Alt-o";

/** Per-depth indent step (px) and the list's base left padding (px). */
const INDENT_PX = 12;
const BASE_PAD_PX = 8;

/** Trailing debounce for edit-driven rebuilds — keeps the full tree walk off
 *  the per-keystroke path while the panel is open. */
const REBUILD_DEBOUNCE_MS = 200;

/** Ceiling (ms) for the ONE forced complete parse on the deliberate open. A
 *  ceiling, not a wait: an already-parsed live view returns instantly. Only a
 *  pathological multi-MB document not yet parsed to its end can hit it, in which
 *  case `ensureSyntaxTree` returns null and we fall back to the partial
 *  `syntaxTree` (best-effort, filled in on scroll by the update() tree-identity
 *  check). Edit-driven refreshes never force a parse — they read syntaxTree. */
const PARSE_BUDGET_MS = 500;

class OutlinePanel implements PluginValue {
  private readonly host: HTMLElement;
  private readonly toggleEl: HTMLButtonElement;
  private readonly panelEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private open = false;
  private headings: OutlineHeading[] = [];
  /** Signature of the last rendered list; null forces the first render. */
  private renderedSignature: string | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {
    // In production the EditorView is mounted inside the `.quoll-editor` host,
    // which is the overlay's positioned ancestor (styles.css sets
    // position: relative on it). Fail fast rather than attaching the overlay
    // into CodeMirror's own managed DOM (view.dom) if that host is missing.
    const host = requireQuollEditorHost(view, "quollOutline");
    this.host = host;

    this.toggleEl = document.createElement("button");
    this.toggleEl.type = "button";
    this.toggleEl.className = "quoll-outline-toggle";
    this.toggleEl.title = "Toggle document outline (Ctrl/Cmd+Alt+O)";
    this.toggleEl.setAttribute("aria-label", "Toggle document outline");
    this.toggleEl.setAttribute("aria-pressed", "false");
    this.toggleEl.textContent = "☰"; // ☰
    // preventDefault on mousedown so clicking the button does not blur/move the
    // editor selection before we act; focus is managed explicitly on jump.
    this.toggleEl.addEventListener("mousedown", (e) => e.preventDefault());
    this.toggleEl.addEventListener("click", (e) => {
      e.preventDefault();
      this.toggle();
    });

    this.panelEl = document.createElement("div");
    this.panelEl.className = "quoll-outline-panel";
    this.panelEl.hidden = true;

    const header = document.createElement("div");
    header.className = "quoll-outline-header";
    const titleEl = document.createElement("span");
    titleEl.className = "quoll-outline-title";
    titleEl.textContent = "Outline";
    const closeEl = document.createElement("button");
    closeEl.type = "button";
    closeEl.className = "quoll-outline-close";
    closeEl.title = "Close outline";
    closeEl.setAttribute("aria-label", "Close outline");
    closeEl.textContent = "×"; // ×
    closeEl.addEventListener("mousedown", (e) => e.preventDefault());
    closeEl.addEventListener("click", (e) => {
      e.preventDefault();
      this.setOpen(false);
    });
    header.appendChild(titleEl);
    header.appendChild(closeEl);

    this.listEl = document.createElement("ul");
    this.listEl.className = "quoll-outline-list";

    this.panelEl.appendChild(header);
    this.panelEl.appendChild(this.listEl);

    this.host.appendChild(this.toggleEl);
    this.host.appendChild(this.panelEl);
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
    this.toggleEl.remove();
    this.panelEl.remove();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panelEl.hidden = !open;
    this.toggleEl.setAttribute("aria-pressed", String(open));
    this.toggleEl.classList.toggle("active", open);
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    // Opening is a deliberate action — rebuild immediately AND force a complete
    // parse so the WHOLE document's headings appear, not just the parsed
    // viewport. This is the only forced parse; it is off the keystroke path.
    if (open) {
      this.rebuild(true);
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

/** The outline extension: the overlay ViewPlugin + its toggle keymap. */
export function quollOutline(): Extension {
  return [outlinePlugin, outlineKeymap];
}
