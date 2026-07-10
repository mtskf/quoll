// src/webview/cm/reading-stats/reading-stats.ts
// Passive per-document reading-stats readout. A ViewPlugin that renders a small
// non-interactive element docked bottom-right of the .quoll-editor host and
// refreshes it on a debounced timer after edits, so the keystroke path pays
// nothing. View-only: it never dispatches a document change (byte-identical) and
// never talks to the host — stats are derived purely from the CM document text
// (compute.ts) and the already-built Lezer tree (structure.ts).

import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { requireQuollEditorHost } from "../editor-host.js";
import { computeReadingStats } from "./compute.js";
import { countStructure } from "./structure.js";

/** Trailing debounce (ms) — keeps the recompute off the per-keystroke path.
 *  Matches the outline panel's amortised-refresh posture. */
const RECOMPUTE_DEBOUNCE_MS = 300;

function pluralise(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

class ReadingStats implements PluginValue {
  private readonly el: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Latch so a deterministic render throw logs once, not on every edit. */
  private loggedError = false;

  constructor(private readonly view: EditorView) {
    this.el = document.createElement("div");
    this.el.className = "quoll-reading-stats";
    this.el.setAttribute("aria-hidden", "true"); // passive decorative readout
    requireQuollEditorHost(view, "quollReadingStats").appendChild(this.el);
    this.render();
  }

  update(u: ViewUpdate): void {
    if (u.docChanged) {
      this.schedule();
    }
  }

  destroy(): void {
    // clearTimer() is synchronous and CM never calls update()/schedules after
    // destroy(), so no fired-timer render() can observe a destroyed this.view.
    this.clearTimer();
    this.el.remove();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.render();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private render(): void {
    // Wrapped in try/catch: this runs in a bare setTimeout macrotask OUTSIDE
    // CodeMirror's transaction error boundary, so an unexpected throw from the
    // (pure, unit-tested) compute/structure helpers would otherwise escape as an
    // unhandled webview error and freeze the readout on stale numbers with no
    // retry. Keep the last-good text in place and log ONCE so a deterministic
    // throw on the current doc does not spam the console. Not expected to fire —
    // defense-in-depth for a widget that runs on every doc edit.
    try {
      const text = this.view.state.sliceDoc();
      const { words, characters, readingTimeMinutes } = computeReadingStats(text);
      const { headings, links } = countStructure(syntaxTree(this.view.state));

      const time = readingTimeMinutes === 0 ? "< 1 min" : `${readingTimeMinutes} min read`;
      this.el.textContent = `${pluralise(words, "word")} · ${pluralise(characters, "char")} · ${time}`;
      this.el.title = `${pluralise(headings, "heading")} · ${pluralise(links, "link")}`;
    } catch (err) {
      if (!this.loggedError) {
        this.loggedError = true;
        console.error("[quoll] reading-stats render failed", err);
      }
    }
  }
}

export function quollReadingStats(): Extension {
  return ViewPlugin.fromClass(ReadingStats);
}
