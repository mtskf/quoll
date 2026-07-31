// Bullet-marker unification (`*`/`+` -> `-`). A marker-char change is a
// CommonMark list boundary, so a rewrite can change rendering two ways:
//   1. cross-list MERGE with a directly-adjacent bullet list (or tight<->loose
//      flip) — filtered out by classifyDocument's `adjacencySafe` flag;
//   2. self-collision — a list item made of dashes/spaces becomes a thematic
//      break once the marker is `-` (`* --` -> `- --` is a HorizontalRule).
// The structure oracle (structureSignature) is authoritative for both, but a
// naive per-group re-parse is O(groups x doc). So: OPTIMISTIC first — apply every
// adjacency-safe group at once; if the signature is unchanged we are done in a
// single extra parse (the common case, no matter how many lists). PESSIMISTIC
// fallback only when that fails — isolate the offending group(s) by re-checking
// each solo, then a final combined check so an adjacency blind spot degrades to a
// safe no-op (return []), never corruption. Already-`-` marks and skipped groups
// emit nothing, so the rule is idempotent.
import { applyEdits, type Edit } from "./edit.js";
import { structureSignature } from "./parse-signature.js";
import type { BulletList } from "./segment.js";

export function bulletUnifyEdits(source: string, bulletLists: readonly BulletList[]): Edit[] {
  const baseSignature = structureSignature(source);
  const groups: Edit[][] = [];
  for (const list of bulletLists) {
    if (!list.adjacencySafe) {
      continue;
    }
    const groupEdits: Edit[] = [];
    for (const mark of list.marks) {
      if (mark.text !== "-") {
        groupEdits.push({ from: mark.from, to: mark.to, insert: "-" });
      }
    }
    if (groupEdits.length > 0) {
      groups.push(groupEdits);
    }
  }
  if (groups.length === 0) {
    return [];
  }
  // Optimistic: whole-document rewrite preserves structure -> apply all.
  // applyEdits sorts internally, so passing the unsorted concat is fine.
  const all = groups.flat();
  if (structureSignature(applyEdits(source, all)) === baseSignature) {
    return all;
  }
  // Pessimistic: a collision exists; keep only groups that are safe in isolation.
  const kept: Edit[] = [];
  for (const groupEdits of groups) {
    if (structureSignature(applyEdits(source, groupEdits)) === baseSignature) {
      kept.push(...groupEdits);
    }
  }
  if (kept.length === 0) {
    return [];
  }
  // Final combined check: covers the (rare) adjacency blind spot where two
  // groups are each solo-safe but merge when applied together -> safe no-op.
  if (structureSignature(applyEdits(source, kept)) !== baseSignature) {
    return [];
  }
  return kept;
}
