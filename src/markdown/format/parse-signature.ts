// Nesting-aware structural signature: a parenthesized DFS of node TYPE names
// from the shared GFM parse tree (offsets + leaf text ignored, tree SHAPE
// preserved). Equal signatures ⇒ same block structure UP TO list tightness —
// no current format rule changes blank-line presence, so tight/loose (which is
// invisible here) cannot flip; a future rule that alters blank lines would need
// its own guard. Because the signature encodes nesting (enter "(" / leave ")"),
// it detects de-nesting a flat name list would miss; and @lezer/markdown emits
// HardBreak nodes, so hard-break loss is detected too.
import { gfmParser } from "../gfm-parser.js";

export function structureSignature(source: string): string {
  const parts: string[] = [];
  gfmParser.parse(source).iterate({
    enter: (n) => {
      parts.push(`(${n.name}`);
    },
    leave: () => {
      parts.push(")");
    },
  });
  return parts.join("");
}
