export {
  type ArbitrateInput,
  arbitrate,
  createSyntaxReveal,
  quollBlockReplaceZones,
  quollSyntaxExclusionZones,
} from "./orchestrator.js";
export type { BuildContext, DecorationProvider } from "./types.js";

import { blockquoteReveal } from "./blockquote-reveal.js";
import { fencedCodeReveal } from "./fenced-code-reveal.js";
import { headingReveal } from "./heading-reveal.js";
import { inlineMarkReveal } from "./inline-mark-reveal.js";
import { linkReveal } from "./link-reveal.js";
import { createSyntaxReveal } from "./orchestrator.js";
import { taskCheckboxReveal } from "./task-checkbox-reveal.js";

/** Module-level stable array — captured once by createSyntaxReveal() so the
 *  ViewPlugin doesn't see a fresh provider list per render. Order is not a
 *  priority claim (review fix #4 from C4a — arbitration is by exclusion zone
 *  only, not by layer order); each new provider is appended to keep the diff
 *  minimal (heading/blockquote/inline/link in C4, task-checkbox in C5,
 *  fenced-code last as block-style.ts's fence-mark companion). */
export const syntaxRevealProviders = [
  headingReveal,
  blockquoteReveal,
  inlineMarkReveal,
  linkReveal,
  taskCheckboxReveal,
  fencedCodeReveal,
] as const;

/** The single extension entry `editor.ts` registers. Bundles every
 *  reveal-only syntax provider (heading, blockquote, inline-mark, link,
 *  task-checkbox as of C5) behind the orchestrator's arbitration. Later
 *  slices that need additional DOM (e.g. C6b–d table, C7 image) extend
 *  this same array — there is no separate composition entry. */
export function quollSyntaxReveal() {
  return createSyntaxReveal(syntaxRevealProviders);
}
