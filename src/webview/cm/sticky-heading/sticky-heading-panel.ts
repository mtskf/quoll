// Sticky current-section heading. A webview-native ViewPlugin that pins one bar
// at the top of the `.quoll-editor` host showing the heading of the section that
// owns the top of the viewport. CM-native + view-only:
//   - Headings come from the shared `extractOutline` (syntaxTree walk), cached
//     and refreshed on doc / syntax-tree-identity change (NO DOM polling). The
//     region ABOVE the viewport is not guaranteed parsed by CM's viewport-first
//     background parser, so completeness is enforced on demand by a bounded
//     `ensureSyntaxTree(state, topPos, budget)` whose RETURN VALUE is used
//     (ensureSyntaxTree does not write back into state's stored tree).
//   - The active heading is chosen by the pure `activeStickyHeading` from the
//     top-visible document position, read from CM geometry via pure
//     `stickyTopHeight` inside ONE keyed `requestMeasure` (driven by a passive
//     `scroll` listener AND relevant ViewUpdates — CM coalesces to one read+write
//     per frame; replaces a hand-rolled rAF, no double-fire). The boundary is the
//     bar's BOTTOM edge so the bar never occludes the heading it is about to show.
//   - The inner band is positioned from `.cm-content`'s measured left+width: the
//     scroller group-centres the foldGutter+content pair, which CSS centring
//     cannot mirror, so the plugin overlays the reading column exactly.
//   - Display-only: no document mutation, no CM change, no write-lock, no message.

import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { type EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { requireQuollEditorHost } from "../editor-host.js";
import { extractOutline, type OutlineHeading } from "../outline/build-outline.js";
import { activeStickyHeading } from "./active-heading.js";
import { stickyTopHeight } from "./viewport-top.js";

/** Ceiling (ms) for the ON-DEMAND bounded parse up to the viewport top when the
 *  above-viewport region is not yet parsed (jump-scroll). A ceiling, not a wait —
 *  an already-parsed region early-returns before this; on exhaustion we fall back
 *  to best-effort `syntaxTree` and self-heal on the next worker dispatch or any
 *  user interaction (CM's ParseWorker resumes rather than restarts; NOT a timer
 *  guarantee). Never a WHOLE-document parse: bounded to `topPos`. */
const PARSE_BUDGET_MS = 50;

/** One coalesced measure-read result: the top-visible position PLUS the reading
 *  column's measured geometry (so the bar overlays .cm-content exactly). */
interface StickyMeasure {
  topPos: number;
  left: number;
  width: number;
}

class StickyHeadingPanel implements PluginValue {
  private readonly host: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly innerEl: HTMLElement;
  private readonly scroller: HTMLElement;
  private headings: OutlineHeading[] = [];
  /** Forces the first cache build; set again on every doc / tree-identity change. */
  private headingsDirty = true;
  /** `from\n text` of the rendered heading, or null when hidden — de-dups DOM
   *  writes on BOTH position and text so a text-only edit still re-renders. */
  private renderedKey: string | null = null;
  private destroyed = false;
  private readonly onScroll = (): void => {
    this.view.requestMeasure(this.measureReq);
  };
  private readonly measureReq = {
    key: this,
    read: (view: EditorView): StickyMeasure => this.measure(view),
    write: (m: StickyMeasure): void => {
      if (this.destroyed) {
        return;
      }
      // Align the inner band to the ACTUAL reading column: the scroller
      // group-centres the [foldGutter][content] pair, so CSS alone (which would
      // centre 60em within the full width) sits ~half-a-gutter left of the prose.
      // Overlay .cm-content exactly by its measured left + width.
      this.innerEl.style.marginLeft = `${m.left}px`;
      this.innerEl.style.width = `${m.width}px`;
      this.applyTop(m.topPos);
    },
  };

  constructor(private readonly view: EditorView) {
    this.host = requireQuollEditorHost(view, "quollStickyHeading");
    this.scroller = view.scrollDOM;

    this.barEl = document.createElement("div");
    this.barEl.className = "quoll-sticky-heading";
    this.barEl.hidden = true;
    this.barEl.setAttribute("aria-hidden", "true"); // presentation-only breadcrumb
    this.innerEl = document.createElement("div");
    this.innerEl.className = "quoll-sticky-heading-inner";
    this.barEl.appendChild(this.innerEl);
    this.host.appendChild(this.barEl);

    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.view.requestMeasure(this.measureReq); // first paint, after layout
  }

  update(u: ViewUpdate): void {
    if (u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.headingsDirty = true;
    }
    if (
      u.docChanged ||
      u.viewportChanged ||
      u.geometryChanged ||
      syntaxTree(u.startState) !== syntaxTree(u.state)
    ) {
      this.view.requestMeasure(this.measureReq);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.barEl.remove();
  }

  /** The coalesced measure read: the top-visible position (boundary at the bar's
   *  BOTTOM edge so the bar never occludes the heading it is about to show) plus
   *  the reading column's measured left/width. Pure height math in
   *  `stickyTopHeight`; `lineBlockAtHeight` + getBoundingClientRect need layout,
   *  so this MUST run in a measure `read` phase. */
  private measure(view: EditorView): StickyMeasure {
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const contentRect = view.contentDOM.getBoundingClientRect();
    const barHeight = this.barEl.hidden ? 0 : this.barEl.getBoundingClientRect().height;
    const height = stickyTopHeight({
      scrollerTop: scrollerRect.top,
      documentTop: view.documentTop,
      barHeight,
      contentHeight: view.contentHeight,
    });
    // getBoundingClientRect() is SCREEN space; the inner band is positioned with
    // LAYOUT px (marginLeft/width), so divide the screen measurements by scaleX to
    // convert screen→layout (identity when the editor is not CSS-transformed).
    const { scaleX } = view;
    return {
      topPos: view.lineBlockAtHeight(height).from,
      left: (contentRect.left - scrollerRect.left) / scaleX,
      width: contentRect.width / scaleX,
    };
  }

  /** Ensure the cached heading list is complete up to `topPos`, parsing the
   *  above-viewport region on demand (bounded) if CM has not parsed it yet.
   *  Uses ensureSyntaxTree's RETURN value — it does not write back into state. */
  private ensureHeadings(topPos: number): void {
    const state = this.view.state;
    if (!this.headingsDirty && syntaxTreeAvailable(state, topPos)) {
      return;
    }
    const tree = ensureSyntaxTree(state, topPos, PARSE_BUDGET_MS) ?? syntaxTree(state);
    this.headings = extractOutline(state, tree);
    this.headingsDirty = false;
  }

  /** Refresh the cache (parse-on-demand), select the active heading for
   *  `topVisibleFrom`, and render/hide the bar. Public — the ViewPlugin's test
   *  seam (bypasses the geometry read, which needs layout happy-dom lacks). */
  applyTop(topVisibleFrom: number): void {
    this.ensureHeadings(topVisibleFrom);
    this.render(activeStickyHeading(this.headings, topVisibleFrom));
  }

  private render(active: OutlineHeading | null): void {
    const key = active ? `${active.from}\n${active.text}` : null;
    if (key === this.renderedKey) {
      return;
    }
    this.renderedKey = key;
    const wasHidden = this.barEl.hidden;
    if (active) {
      this.innerEl.textContent = active.text.length > 0 ? active.text : "(untitled)";
      this.barEl.hidden = false;
    } else {
      this.barEl.hidden = true;
    }
    // A visibility flip changes barHeight, so the boundary the active heading was
    // just chosen against is stale by one bar-height. Re-measure ONCE so the
    // bar-bottom boundary is applied with the now-correct height; `stickyTopHeight`
    // monotonicity converges in a single step (no loop — the re-render early-returns
    // on an unchanged key, and a changed key keeps visibility, not flipping it).
    if (this.barEl.hidden !== wasHidden && !this.destroyed) {
      this.view.requestMeasure(this.measureReq);
    }
  }
}

/** Exported so the tests reach the instance via `view.plugin(...)`. */
export const stickyHeadingPlugin = ViewPlugin.fromClass(StickyHeadingPanel);

/** The sticky-heading extension: the pinned current-section bar ViewPlugin. */
export function quollStickyHeading(): Extension {
  return stickyHeadingPlugin;
}
