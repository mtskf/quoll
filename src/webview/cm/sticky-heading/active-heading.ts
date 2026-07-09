// Pure selection of the "current section" heading for the sticky-heading bar.
// Layout-free + view-only: the caller derives `headings` from the shared
// `extractOutline` (syntaxTree walk) and `topVisibleFrom` from CM geometry;
// this module only picks which heading is active, and never mutates the doc.

import type { OutlineHeading } from "../outline/build-outline.js";

/** The nearest heading STRICTLY ABOVE the top-visible line — the section the
 *  viewport top sits in: the heading with the GREATEST `from` that is `<`
 *  `topVisibleFrom`. NOT a hierarchical parent — it is the nearest *preceding*
 *  heading in document order (possibly a sibling / deeper level). Strict `<` so
 *  while a heading's OWN line is the top-visible line the bar shows the heading
 *  above it rather than duplicating the on-screen one, swapping to that heading as
 *  it scrolls off the top. Returns `null` when no heading is above. Order-
 *  independent (a full max-scan, not an early break), so it does not silently
 *  depend on `headings` being sorted — although `extractOutline` returns them in
 *  ascending `from` order. */
export function activeStickyHeading(
  headings: OutlineHeading[],
  topVisibleFrom: number
): OutlineHeading | null {
  let active: OutlineHeading | null = null;
  for (const heading of headings) {
    if (heading.from < topVisibleFrom && (active === null || heading.from > active.from)) {
      active = heading;
    }
  }
  return active;
}
