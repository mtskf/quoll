// src/webview/cm/reading-stats/structure.ts
// Heading + link counts from the ALREADY-BUILT Lezer syntax tree — no second
// parse. Headings reuse the shared collectHeadings walk (src/webview/cm/
// headings.ts); links are a single node-name tally in the same tree. View-only.

import type { syntaxTree } from "@codemirror/language";
import { collectHeadings } from "../headings.js";

type Tree = ReturnType<typeof syntaxTree>;

export interface DocStructureCounts {
  headings: number;
  links: number;
}

/** Tally explicit Markdown links (inline `[t](u)` + reference `[t][r]`), both
 *  named `Link` by @lezer/markdown. Autolinks/images are intentionally excluded. */
export function countStructure(tree: Tree): DocStructureCounts {
  let links = 0;
  tree.iterate({
    enter: (node) => {
      if (node.name === "Link") {
        links += 1;
      }
    },
  });
  return { headings: collectHeadings(tree).length, links };
}
