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
  // is a bypass of this choke point. The VS Code webview sandbox happens to
  // neutralise the open today (its iframe carries no `allow-popups`), but the
  // guard must not depend on that host-controlled flag. Middle-click-to-open is
  // not a supported gesture — the vetted escape hatch is Cmd/Ctrl+left-click —
  // so preventDefault every `auxclick` unconditionally (button-agnostic: a
  // narrowing to button 1 would reopen the guard for the back/forward buttons,
  // which fire `auxclick` too).
  a.addEventListener("auxclick", (event) => {
    event.preventDefault();
  });
  // Right-click's native "Open Link" (context menu) is a sibling native gesture
  // that, like middle-click, bypasses the click-only guard and would navigate
  // using the live href without the host round-trip. It is deliberately NOT
  // suppressed here, and it does not need to be. RECORDED BEHAVIOUR: in a plain
  // browser the native menu opens the href directly; inside the VS Code webview
  // the iframe sandbox (no `allow-popups`) neutralises the new-tab open, same as
  // the auxclick case above. We do not rely on that host-controlled flag, and we
  // must not blanket-preventDefault `contextmenu`: that also cancels
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
          case "link": {
            const href = renderableHref(leaf.safeUrl);
            if (href !== null) {
              flushPending();
              const a = document.createElement("a");
              a.href = href;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.label.from, leaf.label.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              // Unsafe or over-cap URL — merge the full source slice into
              // pending text (inert), so no native gesture can open it.
              pendingText += raw.slice(node.span.from, node.span.to);
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
              const el = document.createElement("img");
              el.src = src;
              el.alt = commonMarkAltText(raw.slice(leaf.alt.from, leaf.alt.to));
              out.push(el);
            } else {
              pendingText += raw.slice(node.span.from, node.span.to);
            }
            break;
          }
          case "autolink": {
            const href = renderableHref(leaf.safeUrl);
            if (href !== null) {
              flushPending();
              const a = document.createElement("a");
              a.href = href;
              a.rel = "noopener noreferrer";
              a.textContent = raw.slice(leaf.content.from, leaf.content.to);
              attachLinkClickGuard(a);
              out.push(a);
            } else {
              pendingText += raw.slice(node.span.from, node.span.to);
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
