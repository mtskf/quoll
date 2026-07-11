// Lucide icons (https://lucide.dev, MIT) for the outline sidebar, built as SVG
// DOM subtrees — createElementNS, never innerHTML (the src/** no-innerHTML
// invariant, enforced by test/markdown/url-choke-point.test.ts). Path data is
// inlined so no dependency is added; stroke=currentColor makes each icon track
// its button's `color` (the pin turns red purely via CSS on `.pinned`).
// Same construction pattern as cm/switch-editor.ts's file-pen-line icon.

const SVG_NS = "http://www.w3.org/2000/svg";

function createLucideSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function appendPaths(svg: SVGSVGElement, ds: readonly string[]): void {
  for (const d of ds) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
}

function appendLines(
  svg: SVGSVGElement,
  lines: readonly (readonly [number, number, number, number])[]
): void {
  for (const [x1, y1, x2, y2] of lines) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    svg.appendChild(line);
  }
}

/** Lucide `menu` — the corner outline toggle (hamburger). */
export function createMenuIcon(): SVGSVGElement {
  const svg = createLucideSvg();
  appendLines(svg, [
    [4, 6, 20, 6],
    [4, 12, 20, 12],
    [4, 18, 20, 18],
  ]);
  return svg;
}

/** Lucide `chevron-right` — the collapsible header twistie (CSS rotates it to
 *  chevron-down when the section is expanded). */
export function createChevronIcon(): SVGSVGElement {
  const svg = createLucideSvg();
  appendPaths(svg, ["m9 18 6-6-6-6"]);
  return svg;
}

/** Lucide `pin` — the sidebar's pin/unpin toggle. */
export function createPinIcon(): SVGSVGElement {
  const svg = createLucideSvg();
  appendPaths(svg, [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
  ]);
  return svg;
}

/** Lucide `settings` — the sidebar footer's settings entry. */
export function createSettingsIcon(): SVGSVGElement {
  const svg = createLucideSvg();
  appendPaths(svg, [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  ]);
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "3");
  svg.appendChild(circle);
  return svg;
}
