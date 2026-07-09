// Pure selection of the "current section" heading for the sticky-heading bar.
// Layout-free + view-only: the caller derives `headings` from the shared
// `extractOutline` (syntaxTree walk) and `topVisibleFrom` from CM geometry;
// this module only picks which heading is active, and never mutates the doc.

import type { OutlineHeading } from "../outline/build-outline.js";

/** The nearest heading STRICTLY ABOVE the top-visible line — the section the
 *  viewport top sits in: the last heading whose `from` is `<` `topVisibleFrom`.
 *  NOT a hierarchical parent — it is the nearest *preceding* heading in document
 *  order (possibly a sibling / deeper level). Strict `<` so while a heading's OWN
 *  line is the top-visible line the bar shows the heading above it rather than
 *  duplicating the on-screen one, swapping to that heading as it scrolls off the
 *  top. Returns `null` when no heading is above. `headings` MUST be ascending by
 *  `from` (as `extractOutline` returns them). */
export function activeStickyHeading(
  headings: OutlineHeading[],
  topVisibleFrom: number
): OutlineHeading | null {
  let active: OutlineHeading | null = null;
  for (const heading of headings) {
    if (heading.from < topVisibleFrom) {
      active = heading;
    } else {
      break;
    }
  }
  return active;
}
