// Render a GFM table cell's raw Markdown to a flat list of DOM nodes for the
// readonly table widget. The DOM-free half of the pipeline — the CommonMark
// inline tokenizer + IR (`parseCellInline` → `Resolved<CellLeaf>[]`) — lives in
// the neutral `cm/inline/` module; this file drives that IR to DOM:
//
//   parseCellInline(raw) → Resolved<CellLeaf>[]   [inline/inline-ir.ts]
//     → renderReadonly(ir, raw) → Node[] + CellSourceMap
//
// The walker emits, in the SAME pass, a rendered-text → source-run map
// (cell-source-map.ts) — because only this file knows which IR spans actually
// become rendered text (a live link renders only its label, an inert one its
// whole source slice, a live image no text at all). That makes the renderer the
// mapping authority for drag selection; re-deriving the map at gesture time
// would duplicate the live-vs-inert security decisions below in a second walker
// free to drift from this one. `renderCellInto` is the only supported way to
// fill a cell, so a call site cannot append nodes without registering the map
// that describes them.
//
// The C4a orchestrator drops its reveal spans inside the widget range via the
// `quollBlockReplaceZones` facet, so the widget owns the rendering for these
// constructs WITHOUT a coloured reveal highlight bleeding in.
//
// The URL-safety verdict for every link / image / autolink is computed in the
// tokenizer (inline/inline-ir.ts, via the SHARED
// `renderSafeMarkdownDestination`) and carried in the IR leaf; renderReadonly
// only reads it. Blocked URLs render as inert text identical to the source
// slice (no live `<a>`, no `<img>`).
//
// Image srcs take ONE extra render-time step: a relative destination is
// resolved against the document's resource base and directory-contained via
// the SHARED resolveAgainstBase (image/resource-base.ts) — the same gate the
// block-image widget uses — so a `../` (or `..%2f`) table-cell image renders
// inert instead of escaping the document folder. Links/autolinks need no
// resolve: a relative <a href> never auto-fetches and the click guard blocks
// non-absolute navigation.

import { MAX_HREF_LENGTH } from "../../../shared/protocol.js";
import { resolveAgainstBase } from "../image/resource-base.js";
import type { Resolved, Span } from "../inline/inline-emphasis.js";
import {
  assertNever,
  type CellLeaf,
  commonMarkAltText,
  MAX_INLINE_NESTING_DEPTH,
  parseCellInline,
} from "../inline/inline-ir.js";
import { type CellSourceMap, type CellSourceRun, setCellSourceMap } from "./cell-source-map.js";

// Plain-click on a widget-internal link must NOT navigate the browser — that
// bypasses the widget's caret-dispatch handler and the user loses the only
// path to edit the link source. We preventDefault() unless the user holds a
// platform modifier (Cmd on Mac, Ctrl elsewhere), matching VS Code Markdown
// preview / Go-to-Definition convention. The bubbled click then reaches the
// widget root and fires reveal-on-caret (C6b smoke #5).
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const LINK_TOOLTIP = `${IS_MAC ? "Cmd" : "Ctrl"}+click to open`;

// Modifier-click is the "external navigate" escape hatch — but only for
// hrefs that resolve to an external target the user can act on (https/http
// open in the system browser, mailto opens a mail client). `isAllowedUrl`
// deliberately accepts schemeless strings (relative paths / fragments) as
// "safe", which ships them as live `<a href="./doc.md">` etc. Inside the
// VS Code webview iframe, modifier-click on a relative or fragment href
// has no defined behaviour (may navigate the frame, may do nothing).
// preventDefault unless the raw href matches one of the absolute schemes
// that are safe to open externally (https, http, mailto — mirrors
// ALLOWED_URL_SCHEMES in url-allowlist.ts; keep in sync if that set
// changes). Use `getAttribute("href")` (NOT `a.href`) so we read what
// the renderer wrote; `a.href` is normalised by the browser to an
// absolute URL even for relative input, which would defeat the check.
//
// This guard decides "opens externally" for a LEFT-click: an absolute href is
// left un-preventDefault'd and bubbles to the widget root handler, which routes
// it through the host `open-external` choke point. The MAX_HREF_LENGTH cap is
// NOT re-checked here — it is enforced one layer up by `renderableHref`, so
// every live `<a href>` reaching this guard is already within the cap (an
// over-length URL never becomes a live link — see renderReadonly).
const ABSOLUTE_HREF_RE = /^(?:https?:|mailto:)/i;

function attachLinkClickGuard(a: HTMLAnchorElement): void {
  a.title = LINK_TOOLTIP;
  a.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey) {
      const href = a.getAttribute("href") ?? "";
      // Absolute scheme → leave un-preventDefault'd so the widget root handler
      // routes it through the host open-external gate. Relative / fragment
      // hrefs fall through to preventDefault → caret reveal (their in-webview
      // navigation is undefined). No length check: renderableHref already
      // guaranteed href.length <= MAX_HREF_LENGTH for every live link.
      if (ABSOLUTE_HREF_RE.test(href)) {
        return;
      }
    }
    event.preventDefault();
  });
  // Button-1 (middle-click) activation rides `auxclick` + the browser's native
  // "open in new tab" default — it does NOT fire `click`, so the guard above
  // never runs and the widget root handler (also `click`-only) never routes it
  // through the host `open-external` re-validation + MAX_HREF_LENGTH cap. That
  // is a bypass of this choke point. Whether the VS Code webview's iframe
  // sandbox (no `allow-popups`) also blocks this specific new-tab open is NOT
  // verified here — .claude/docs/LEARNING.md's 2026-06-15 entry recorded a
  // DIFFERENT but cautionary result: an unmodified `<a href>` click on this
  // same webview was predicted to silently no-op under the CSP sandbox, but a
  // built-in VS Code handler forwarded it externally anyway. That entry says
  // nothing about the `allow-popups` attribute specifically — it is cited only
  // as evidence that "the sandbox will neutralise it" predictions have been
  // wrong before on this webview, so this guard does not assume the sandbox
  // saves us. Middle-click-to-open is not a supported gesture — the vetted
  // escape hatch is Cmd/Ctrl+left-click —
  // so preventDefault every `auxclick` unconditionally (button-agnostic: a
  // narrowing to button 1 would reopen the guard for the back/forward buttons,
  // which fire `auxclick` too).
  a.addEventListener("auxclick", (event) => {
    event.preventDefault();
  });
  // Right-click's native "Open Link" (context menu) is a sibling native gesture
  // that, like middle-click, bypasses the click-only guard and would navigate
  // using the live href without the host round-trip. It is deliberately NOT
  // suppressed here. UNVERIFIED, DO NOT RELY ON: in a plain browser the native
  // menu opens the href directly; whether the VS Code webview's iframe sandbox
  // (no `allow-popups`) also blocks this specific gesture has not been smoke-
  // tested here. .claude/docs/LEARNING.md's 2026-06-15 entry is a cautionary
  // precedent, not corroboration of the `allow-popups` claim itself: a plain
  // `<a href>` click on this same webview was predicted to be neutralised by
  // the CSP sandbox but a built-in VS Code handler forwarded it externally
  // anyway — so this guard does not assume the sandbox saves us either
  // way. We must not blanket-preventDefault `contextmenu`: that also cancels
  // keyboard-invoked menus (Shift+F10 / Menu key), stripping Copy / Open Link
  // from keyboard users with no accessible replacement (an a11y regression), and
  // replacing the native menu with our own is a larger, separate change.
  //
  // Instead the bypass is closed at its ROOT by `renderableHref`: every live
  // `<a href>` is guaranteed BOTH allowlist-safe AND within MAX_HREF_LENGTH, so
  // whatever the native "Open Link" can reach is byte-identical to what the host
  // `open-external` sink would open (the host adds only that redundant allowlist
  // re-check plus the length cap). The over-length residual can no longer render
  // as a live link, so no native gesture — right-click included — can open a URL
  // the host would reject. No `contextmenu` handler is attached.
}

// Gate a tokenizer URL verdict into a href that is safe to expose as a LIVE
// `<a href>`. `leaf.safeUrl` already carries the allowlist verdict; the only
// other thing the host `open-external` sink enforces is the MAX_HREF_LENGTH
// cap, so apply it HERE — at the single point that turns a URL into a live
// link. An over-cap URL returns null → rendered inert (source text), exactly
// like a non-allowlisted URL. Consolidating the cap here (rather than in the
// click guard) is what closes the native-gesture bypasses — right-click "Open
// Link", middle-click, drag — that never run the click guard: an over-length
// URL simply never becomes a live href for them to act on.
function renderableHref(safeUrl: string | null): string | null {
  return safeUrl !== null && safeUrl.length <= MAX_HREF_LENGTH ? safeUrl : null;
}

/** Mutable during the walk (`outerTo` grows as nested emphasis closers
 *  accumulate outward). The map's `readonly CellSourceRun[]` is a VIEW, not a
 *  freeze: `renderCellWithMap` publishes this very array, so the guarantee
 *  rests on the context dying with the call. A `RenderContext` hoisted across a
 *  row's cells (the obvious allocation cut) would mutate maps already
 *  registered for earlier cells, with no type error — do not hoist it. */
type MutableRun = { -readonly [K in keyof CellSourceRun]: CellSourceRun[K] };

/** One per `renderCellWithMap` call, shared across the whole recursion so the
 *  rendered cursor and the pending markup are global to the cell rather than
 *  per emphasis level. */
interface RenderContext {
  /** Rendered characters emitted so far — the next run's `rendered`. */
  cursor: number;
  runs: MutableRun[];
  /** Opener markup waiting for the run it belongs to (`**` before its text,
   *  `[` before a label, a `\` before its escaped char). `null` = none pending. */
  pendingOpen: number | null;
  /** Source that renders NO text has passed since the last run. This is what
   *  keeps a boundary from claiming to be exact across an invisible construct:
   *  it both suppresses the pending opener (that markup is not this run's) and
   *  blocks the closer extension in the emphasis arm. */
  sawSkipped: boolean;
}

function newRenderContext(): RenderContext {
  return { cursor: 0, runs: [], pendingOpen: null, sawSkipped: false };
}

/** The ONLY thing that appends a run or advances the rendered cursor DURING THE
 *  WALK, so every arm below states its source spans and nothing else has to
 *  keep the cursor in step with the DOM it emits. (`renderCellSafely`'s
 *  fallback map is minted outside the walk — see there.)
 *
 *  `[from, to)` are the source characters that render VERBATIM; `outerTo` is
 *  where the construct owning them ends (its closing markup included). */
function emitRun(ctx: RenderContext, from: number, to: number, outerTo: number): void {
  if (from === to) {
    // A construct that renders zero characters (`[](https://…)` → `<a></a>`).
    // Emitting it would put two runs at the same rendered index and make the
    // boundary lookup ambiguous; recording it as skipped is both correct and
    // what stops a later run from claiming this construct's markup.
    ctx.sawSkipped = true;
    return;
  }
  ctx.runs.push({
    rendered: ctx.cursor,
    from,
    to,
    // Invisible source between the pending opener and this run means the opener
    // is not ours — it belongs to whatever rendered nothing in between.
    outerFrom: ctx.sawSkipped ? from : (ctx.pendingOpen ?? from),
    outerTo,
  });
  ctx.cursor += to - from;
  ctx.pendingOpen = null;
  ctx.sawSkipped = false;
}

// Walk a Resolved<CellLeaf>[] and emit DOM nodes byte-identically to the
// previous direct-DOM tokenizer. A pending text buffer merges adjacent text
// values, escape unescaped chars, and inert-construct source slices into a
// single Text node (preserving the single-text-node topology that the
// renderReadonly topology tests pin). Flushed before every element node.
//
// `ctx` collects the source-run map alongside the DOM. It is threaded rather
// than rebuilt per level because a run's outer span can be extended by an
// ANCESTOR emphasis wrapper (`***x***` → one run whose outer span is both
// delimiter pairs), which only a shared run list can express.
function renderReadonly(
  ir: Resolved<CellLeaf>[],
  raw: string,
  resourceBase: string,
  depth: number,
  ctx: RenderContext
): Node[] {
  const out: Node[] = [];
  let pendingText = "";

  const flushPending = (): void => {
    if (pendingText.length > 0) {
      out.push(document.createTextNode(pendingText));
      pendingText = "";
    }
  };

  /** A construct rendered INERT: its whole source slice becomes text (a blocked
   *  or over-cap URL, an emphasis past the nesting cap), so the run is the whole
   *  span and there is no markup for it to own. No flushPending() — we emit no
   *  element, so the slice merges with adjacent text, which is the
   *  single-text-node topology the renderReadonly topology tests pin. */
  const renderInertSource = (span: Span): void => {
    ctx.pendingOpen ??= span.from;
    emitRun(ctx, span.from, span.to, span.to);
    pendingText += raw.slice(span.from, span.to);
  };

  for (const node of ir) {
    switch (node.kind) {
      case "text":
        emitRun(ctx, node.span.from, node.span.to, node.span.to);
        // Slice `raw` rather than trusting `node.value`: the run's LENGTH comes
        // from `node.span`, so the rendered characters must come from the same
        // span or the cursor desynchronises from the DOM. The two are kept in
        // step BY HAND upstream (inline-emphasis.ts trims `value` and `span`
        // together), and a drift there would not be caught by cell-point.ts's
        // staleness check — `renderedText` is read back off the DOM, so it
        // would agree with the DOM while disagreeing with the runs.
        pendingText += raw.slice(node.span.from, node.span.to);
        break;
      case "leaf": {
        const leaf = node.leaf;
        switch (leaf.kind) {
          case "escape":
            // Merge the unescaped char into the pending-text buffer. The `\` is
            // an opener: a boundary at the rendered char expands over it, so
            // selecting the char yields the escape sequence that produces it.
            ctx.pendingOpen ??= node.span.from;
            emitRun(ctx, leaf.char.from, leaf.char.to, node.span.to);
            pendingText += raw.slice(leaf.char.from, leaf.char.to);
            break;
          case "code": {
            flushPending();
            ctx.pendingOpen ??= node.span.from;
            emitRun(ctx, leaf.content.from, leaf.content.to, node.span.to);
            const el = document.createElement("code");
            el.textContent = raw.slice(leaf.content.from, leaf.content.to);
            out.push(el);
            break;
          }
          case "link": {
            const href = renderableHref(leaf.safeUrl);
            if (href !== null) {
              flushPending();
              // Only the LABEL renders; `[` opens and `](url)` closes.
              ctx.pendingOpen ??= node.span.from;
              emitRun(ctx, leaf.label.from, leaf.label.to, node.span.to);
              const a = document.createElement("a");
              a.href = href;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.label.from, leaf.label.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              // Unsafe or over-cap URL — render the full source slice inert, so
              // no native gesture can open it.
              renderInertSource(node.span);
            }
            break;
          }
          case "image": {
            // Allowlist verdict (leaf.safeUrl) is computed in the tokenizer;
            // the base resolve happens HERE because the resource base is a
            // render-time input, not a property of the cell source. Relative
            // srcs resolve against the document base and must stay inside its
            // directory (resolveAgainstBase → resolveTrustedResourceUrl),
            // matching the block-image widget. Fail-closed: no base / escape
            // / resolve failure → inert source text.
            const src =
              leaf.safeUrl !== null ? resolveAgainstBase(leaf.safeUrl, resourceBase) : null;
            if (src !== null) {
              flushPending();
              // A LIVE image renders no text at all (the alt is an attribute,
              // not textContent), so it emits no run — only the skipped flag,
              // which is what makes a boundary beside it answer "no exact
              // mapping" instead of silently landing on one side of it.
              ctx.sawSkipped = true;
              const el = document.createElement("img");
              el.src = src;
              el.alt = commonMarkAltText(raw.slice(leaf.alt.from, leaf.alt.to));
              out.push(el);
            } else {
              renderInertSource(node.span);
            }
            break;
          }
          case "autolink": {
            const href = renderableHref(leaf.safeUrl);
            if (href !== null) {
              flushPending();
              // Only the URL text between `<` and `>` renders.
              ctx.pendingOpen ??= node.span.from;
              emitRun(ctx, leaf.content.from, leaf.content.to, node.span.to);
              const a = document.createElement("a");
              a.href = href;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.content.from, leaf.content.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              renderInertSource(node.span);
            }
            break;
          }
          default:
            assertNever(leaf);
        }
        break;
      }
      case "emphasis": {
        // Delimiter-run wrapper: em/strong (`*`/`_`) or del/mark (`~~`/`==`).
        // `node.tag` is a valid element name, so createElement builds the right
        // box for all four. Past the nesting cap, render the whole span
        // (node.span covers openDelim..closeDelim) as inert literal source
        // instead of recursing — bounds this walker's recursion depth.
        if (depth >= MAX_INLINE_NESTING_DEPTH) {
          renderInertSource(node.span);
          break;
        }
        flushPending();
        // SET-IF-EMPTY, never overwrite: an already-pending OUTER opener wins,
        // so `***x***` and `**_b_**` reach `outerFrom: 0`. Overwriting here
        // would orphan the outer `**` — a boundary at `x` would expand only
        // over the inner delimiters and the selection would no longer
        // round-trip.
        ctx.pendingOpen ??= node.span.from;
        const runsBefore = ctx.runs.length;
        const el = document.createElement(node.tag);
        for (const child of renderReadonly(node.children, raw, resourceBase, depth + 1, ctx)) {
          el.appendChild(child);
        }
        // Runs only ever grow, so this is "the wrapper's subtree rendered text".
        const emittedText = ctx.runs.length > runsBefore;
        if (emittedText && !ctx.sawSkipped) {
          // The wrapper emitted text and nothing invisible follows it, so its
          // closing delimiters belong to the LAST run. `max` because nested
          // closers accumulate outward — em first, then strong. The
          // `!sawSkipped` guard is what keeps a trailing invisible construct
          // (`**a![i](p)**`) from being swallowed into the left run's closers:
          // extending there would make a boundary that straddles the image look
          // exact instead of falling back to the whole-cell snap.
          const last = ctx.runs[ctx.runs.length - 1];
          last.outerTo = Math.max(last.outerTo, node.span.to);
        } else if (!emittedText) {
          // The wrapper rendered nothing (`*![i](p)* a` — the trailing SPACE is
          // load-bearing: with `a` straight after the closer the delimiter run
          // is not right-flanking, no wrapper forms at all, and this arm is
          // never reached). Drop the pending opener so its delimiters are never
          // attributed to a later, unrelated run, and record the skip so the
          // next run keeps its own outer span.
          ctx.pendingOpen = null;
          ctx.sawSkipped = true;
        }
        out.push(el);
        break;
      }
      default:
        assertNever(node);
    }
  }
  flushPending();
  return out;
}

// One-shot latches for the two diagnostics below. Module-scoped because
// `renderCellInto` runs per CELL on every content edit (table-widget.ts's
// `patchRow` re-renders every cell of the table), and both conditions are
// deterministic functions of the cell's bytes — so an unguarded log fires once
// per cell per keystroke for as long as the offending bytes stay in the table,
// and every repeat is byte-identical (the messages deliberately carry no cell
// identity). Same latch, same reason, as table-field.ts's
// `warnedMissingSkeletonField`.
let loggedUntiledMap = false;
let loggedRenderThrow = false;

/** Test-only: re-arm both latches. They are module-scoped BY DESIGN, which
 *  makes each diagnostic observable exactly once per module instance — a test
 *  that asserts one has to re-arm it first, or it pins nothing after whichever
 *  test happened to run first. (Re-importing the module through
 *  `vi.resetModules()` would re-arm them too, but it forks cell-source-map.ts's
 *  registry as well, so the fresh renderer would register maps that the test's
 *  own `getCellSourceMap` cannot see.) */
export function resetCellRenderLogLatchesForTest(): void {
  loggedUntiledMap = false;
  loggedRenderThrow = false;
}

/** Render a cell's raw Markdown to DOM nodes AND the map describing them.
 *
 *  `renderedText` is read back off the emitted nodes rather than accumulated by
 *  the walker: it is the string cell-point.ts compares against the cell's live
 *  `textContent`, so deriving it from the same source as that comparison is
 *  what makes the check meaningful (a walker-side tally could agree with the
 *  runs while disagreeing with the DOM). */
function renderCellWithMap(
  raw: string,
  resourceBase: string
): { nodes: Node[]; map: CellSourceMap } {
  const ctx = newRenderContext();
  const nodes = renderReadonly(parseCellInline(raw), raw, resourceBase, 0, ctx);
  const renderedText = nodes.map((n) => n.textContent ?? "").join("");
  // The runs MUST tile `renderedText` exactly: `sourceOffsetAt`'s interior
  // arithmetic (`run.from + (within - run.rendered)`) assumes it, so a gap —
  // rendered text emitted by a future walker arm without an `emitRun` — shifts
  // every later run and answers a wrong-but-exact-LOOKING offset that neither
  // half of cell-point.ts's staleness check can catch (`renderedText` is read
  // off the DOM, so it agrees with the DOM). Publish NO runs rather than a map
  // that lies: every boundary then answers null and the drag degrades to the
  // whole-cell snap.
  const tiled = ctx.cursor === renderedText.length;
  if (!tiled && !loggedUntiledMap) {
    loggedUntiledMap = true;
    // Lengths only — every field here is a number this file computed, so no
    // document byte is in the payload (edit-sync.ts precedent).
    console.error("[quoll] table cell source map does not tile its render; dropping runs", {
      cursor: ctx.cursor,
      renderedLength: renderedText.length,
      sourceLength: raw.length,
    });
  }
  return {
    nodes,
    map: { runs: tiled ? ctx.runs : [], sourceLength: raw.length, renderedText },
  };
}

/** Defense in depth: the parser is bounded (iterative build + capped walker),
 *  but ANY unforeseen throw must not blank the table widget on seed — fall back
 *  to a single inert source-text node, matching the fail-closed pattern. The
 *  fallback carries the IDENTITY map that node deserves rather than no map at
 *  all: the source renders verbatim, so its offsets really are 1:1, and
 *  producing a map here is what stops a reused `patchRow` cell from keeping the
 *  stale map of whatever it rendered before. */
function renderCellSafely(
  raw: string,
  resourceBase: string
): { nodes: Node[]; map: CellSourceMap } {
  try {
    return renderCellWithMap(raw, resourceBase);
  } catch (err) {
    // The payload carries the failure's SHAPE and nothing from the cell: a
    // name and a length, per the edit-sync.ts precedent. `err.message` is
    // deliberately NOT logged — `err` is not ours, and `assertNever`
    // (inline-ir.ts) interpolates the leaf it rejected, so a broken IR type
    // would put a document-derived destination into that string. A name plus a
    // length still says which failure fired and how big the cell was; recovering
    // the message costs a breakpoint, which is the right trade for a path that
    // only fires on a bug (Codex review, Conf 98).
    // FLATTENED to primitives rather than logged as an object because
    // `message`/`stack` are non-enumerable: any structured copy of this payload
    // (a test's `JSON.stringify`, a log shipper) sees `{}` for an Error and
    // cannot check what it carries — flattening is what makes the leak check in
    // cm-table-cell-map-failclosed.test.ts able to fail at all. Worth logging at
    // all now that a throw also changes drag mapping, not just the render: the
    // cell silently loses its inline constructs AND its exact offsets.
    if (!loggedRenderThrow) {
      loggedRenderThrow = true;
      console.error("[quoll] table cell render threw; falling back to inert source text", {
        // NO property of `err` is read — not `message`, not `name`. Both are
        // the thrower's to define: `assertNever` interpolates the leaf it
        // rejected into its message, a subclass can carry a source-derived
        // name, and either accessor can be a getter that throws INSIDE the
        // handler whose whole job is to keep this path from throwing. A fixed
        // category plus a length is what this module can honestly vouch for;
        // anything finer costs a breakpoint, which is the right trade for a
        // path that only fires on a bug (Codex review, Conf 98 then 88).
        errKind: err instanceof Error ? "Error" : typeof err,
        length: raw.length,
      });
    }
    return {
      nodes: [document.createTextNode(raw)],
      map: {
        // Empty source renders nothing, and a zero-length run is the one shape
        // `emitRun` refuses (two runs at the same rendered index make the
        // boundary lookup ambiguous). No runs is the identity map for "".
        runs:
          raw.length === 0
            ? []
            : [{ rendered: 0, from: 0, to: raw.length, outerFrom: 0, outerTo: raw.length }],
        sourceLength: raw.length,
        renderedText: raw,
      },
    };
  }
}

/** Nodes only — the general renderer API, for callers with no cell element and
 *  no drag to map (the raw-HTML inertness probes, the render tests). */
export function renderCellInline(raw: string, resourceBase = ""): Node[] {
  return renderCellSafely(raw, resourceBase).nodes;
}

/** Fill a rendered table cell: clear it, append the nodes, register the map —
 *  ONE operation, so a call site cannot append content without registering the
 *  map that describes it (which cell-point.ts would then read as "no mapping",
 *  or worse, satisfy with the previous render's map on a reused cell). */
export function renderCellInto(cell: HTMLElement, raw: string, resourceBase = ""): void {
  const { nodes, map } = renderCellSafely(raw, resourceBase);
  cell.textContent = "";
  for (const node of nodes) {
    cell.appendChild(node);
  }
  setCellSourceMap(cell, map);
}
