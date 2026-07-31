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

// Upper bound on the pessimistic pass, which reparses the whole document once
// per group. Capping at 100 bounds that pass to at most ~102 full-document
// reparses so its cost no longer scales with the list count. Each reparse is
// still O(document size), so this caps the list-count multiplier rather than
// absolute time — for realistic documents that stays well under a second;
// inputs above the cap fail closed (a safe no-op). Collision-free documents
// never reach here (they finish on the optimistic single-parse path
// regardless of list count).
const MAX_PESSIMISTIC_GROUPS = 100;

export function bulletUnifyEdits(source: string, bulletLists: readonly BulletList[]): Edit[] {
  const baseSignature = structureSignature(source);
  // The authoritative gate for every pass below: does applying `edits` leave the
  // document's block structure (structureSignature) unchanged? A false result
  // means the marker rewrite would merge/split a list or self-collide into a
  // thematic break, so those edits must be dropped.
  const preservesStructure = (edits: Edit[]): boolean =>
    structureSignature(applyEdits(source, edits)) === baseSignature;
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
  if (preservesStructure(all)) {
    return all;
  }
  // Collision present (optimistic failed). The pessimistic pass reparses once
  // per group; cap it so a pathological document (very many separate bullet
  // lists AND a collision) cannot block the synchronous Format Document command
  // on O(groups × doc) parsing. Fail closed: skip unification for this document
  // (a safe no-op — the collision-free optimistic path above is unaffected).
  if (groups.length > MAX_PESSIMISTIC_GROUPS) {
    return [];
  }
  // Pessimistic: a collision exists; keep only groups that are safe in isolation.
  const kept: Edit[] = [];
  for (const groupEdits of groups) {
    if (preservesStructure(groupEdits)) {
      kept.push(...groupEdits);
    }
  }
  if (kept.length === 0) {
    return [];
  }
  // Final combined check: some solo-safe groups still collide when applied
  // together — e.g. nested collinear markers `+ + +` (three non-sibling, each
  // adjacencySafe lists) collapse to `- - -` (a HorizontalRule), or an adjacency
  // blind spot lets two lists merge. In those cases drop the whole rewrite (safe
  // no-op). This is deliberately conservative for such (rare) inputs: it never
  // corrupts, though it may skip unrelated safe lists in the same document.
  if (!preservesStructure(kept)) {
    return [];
  }
  return kept;
}
