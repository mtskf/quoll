// Render a GFM table cell's raw Markdown to a flat list of DOM nodes for the
// readonly table widget. The DOM-free half of the pipeline — the CommonMark
// inline tokenizer + IR (`parseCellInline` → `Resolved<CellLeaf>[]`) — lives in
// the neutral `cm/inline/` module; this file drives that IR to DOM:
//
//   parseCellInline(raw) → Resolved<CellLeaf>[]   [inline/inline-ir.ts]
//     → renderReadonly(ir, raw) → Node[]
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
import type { Resolved } from "../inline/inline-emphasis.js";
import {
  assertNever,
  type CellLeaf,
  commonMarkAltText,
  MAX_INLINE_NESTING_DEPTH,
  parseCellInline,
} from "../inline/inline-ir.js";

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
// This guard is the single source of truth for "opens externally": an href
// that passes (ABSOLUTE_HREF_RE + length cap) is left un-preventDefault'd
// and bubbles to the widget root handler, which routes it through the host
// `open-external` choke point. Centralising the length cap HERE keeps the
// root handler a dumb router with no length logic of its own.
const ABSOLUTE_HREF_RE = /^(?:https?:|mailto:)/i;

function attachLinkClickGuard(a: HTMLAnchorElement): void {
  a.title = LINK_TOOLTIP;
  a.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey) {
      const href = a.getAttribute("href") ?? "";
      // Absolute AND within the host's inbound cap: leave un-preventDefault'd
      // so the widget root handler routes it through the host open-external
      // gate. An oversize absolute href would be dropped by the host protocol
      // validator (MAX_HREF_LENGTH), which — because the root handler
      // preventDefaults before posting — would leave a dead-click. Cap it HERE
      // so it falls through to preventDefault → caret reveal, exactly like a
      // relative href.
      if (ABSOLUTE_HREF_RE.test(href) && href.length <= MAX_HREF_LENGTH) {
        return;
      }
    }
    event.preventDefault();
  });
}

// Walk a Resolved<CellLeaf>[] and emit DOM nodes byte-identically to the
// previous direct-DOM tokenizer. A pending text buffer merges adjacent text
// values, escape unescaped chars, and inert-construct source slices into a
// single Text node (preserving the single-text-node topology that the
// renderReadonly topology tests pin). Flushed before every element node.
export function renderReadonly(
  ir: Resolved<CellLeaf>[],
  raw: string,
  resourceBase = "",
  depth = 0
): Node[] {
  const out: Node[] = [];
  let pendingText = "";

  const flushPending = (): void => {
    if (pendingText.length > 0) {
      out.push(document.createTextNode(pendingText));
      pendingText = "";
    }
  };

  for (const node of ir) {
    switch (node.kind) {
      case "text":
        pendingText += node.value;
        break;
      case "leaf": {
        const leaf = node.leaf;
        switch (leaf.kind) {
          case "escape":
            // Merge the unescaped char into the pending-text buffer.
            pendingText += raw.slice(leaf.char.from, leaf.char.to);
            break;
          case "code": {
            flushPending();
            const el = document.createElement("code");
            el.textContent = raw.slice(leaf.content.from, leaf.content.to);
            out.push(el);
            break;
          }
          case "link":
            if (leaf.safeUrl !== null) {
              flushPending();
              const a = document.createElement("a");
              a.href = leaf.safeUrl;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.label.from, leaf.label.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              // Unsafe URL — merge the full source slice into pending text (inert).
              pendingText += raw.slice(node.span.from, node.span.to);
            }
            break;
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
              const el = document.createElement("img");
              el.src = src;
              el.alt = commonMarkAltText(raw.slice(leaf.alt.from, leaf.alt.to));
              out.push(el);
            } else {
              pendingText += raw.slice(node.span.from, node.span.to);
            }
            break;
          }
          case "autolink":
            if (leaf.safeUrl !== null) {
              flushPending();
              const a = document.createElement("a");
              a.href = leaf.safeUrl;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.content.from, leaf.content.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              pendingText += raw.slice(node.span.from, node.span.to);
            }
            break;
          default:
            assertNever(leaf);
        }
        break;
      }
      case "emphasis": {
        // Delimiter-run wrapper: em/strong (`*`/`_`) or del/mark (`~~`/`==`).
        // `node.tag` is a valid element name, so createElement builds the right
        // box for all four. Past the nesting cap, merge the inert literal source
        // of the whole span (node.span covers openDelim..closeDelim) into the
        // pending-text buffer instead of recursing — bounds this walker's
        // recursion depth. No flushPending(): we emit no element, so the slice
        // merges naturally with adjacent text (same topology as inert links).
        if (depth >= MAX_INLINE_NESTING_DEPTH) {
          pendingText += raw.slice(node.span.from, node.span.to);
          break;
        }
        flushPending();
        const el = document.createElement(node.tag);
        for (const child of renderReadonly(node.children, raw, resourceBase, depth + 1)) {
          el.appendChild(child);
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

export function renderCellInline(raw: string, resourceBase = ""): Node[] {
  // Defense in depth: the parser is bounded (iterative build + capped walker),
  // but ANY unforeseen throw must not blank the table widget on seed — fall
  // back to a single inert source-text node, matching the fail-closed pattern.
  try {
    return renderReadonly(parseCellInline(raw), raw, resourceBase);
  } catch {
    return [document.createTextNode(raw)];
  }
}
