// Roving-tabindex keyboard navigation for the outline tree (WAI-ARIA tree-view
// pattern): each row <li> IS the focusable treeitem with a single roving tab
// stop; Up/Down/Home/End move focus, Left/Right collapse/expand or climb/dive,
// Enter jumps. Extracted from outline-panel.ts as the sole owner of the
// roving/focus state it navigates.
//
// Ownership boundary (see the panel's constructor note): this module OWNS and is
// the sole mutator of three fields — `rows` (the rendered row model, handed over
// by the panel's renderList via setRows), `tabbableFrom` (the single tab stop),
// and `pendingFocusedFrom` (the roving focus offset, kept in the current doc's
// coordinate space by remapFocus). The fourth entangled field, `collapsedFroms`,
// stays panel-owned: this module only READS collapse state (deps.isCollapsed) and
// asks the panel to change it (deps.toggleCollapse), so no field is written from
// both modules. The panel reads `rows` back through the read-only getter for its
// own refreshVisibility / updateActive passes; it never mutates it.
//
// This module imports NOTHING from @codemirror — remapFocus takes a plain
// position-mapper, not a ChangeDesc — so it stays decoupled from CodeMirror API
// churn (the mapping detail lives on the panel side).
//
// Listener lifecycle: the keydown handler is bound once on the panel-supplied
// `listEl` and needs no explicit removeEventListener — `listEl` is a child of the
// sidebar the panel removes on destroy(), so the listener dies with the element,
// exactly like the panel's own listeners (Escape on sidebarEl, focusin on listEl,
// etc.). A fresh TreeNav + fresh `listEl` is created per plugin instance, so a
// double-bind cannot arise; there is no stateful teardown work here (no timers,
// no persistence, no pointer capture — unlike resize-handle's drag-flush destroy).

import type { OutlineHeading } from "./build-outline.js";

/** A rendered outline row + its structural facts, for post-render visibility
 *  updates that never rebuild the DOM (collapse toggles reuse these refs). The
 *  `li` IS the focusable tree node (roving tabindex); the twistie is an
 *  aria-hidden decorative chevron and the item span is display-only. The panel
 *  builds these in renderList and hands the array over via `setRows`. Fields are
 *  `readonly`: a RowRef is an immutable handle — only the row's DOM element
 *  mutates (li.hidden / li.tabIndex), never the handle's bindings. */
export interface RowRef {
  readonly heading: OutlineHeading;
  readonly hasChildren: boolean;
  readonly li: HTMLLIElement;
  readonly twistie: HTMLSpanElement | null;
}

/** The panel-owned collaborators the tree calls back into. The tree knows
 *  nothing of the panel's collapse set or editor view — it only asks whether a
 *  heading is collapsed, asks the panel to toggle it, asks it to jump the caret,
 *  and asks it to take focus back when the tree can no longer hold it. */
export type TreeNavDeps = {
  /** The role=tree <ul>. The tree binds its keydown handler here and reads
   *  activeElement containment off it (the live-focus gate). */
  listEl: HTMLElement;
  /** Is this heading offset currently collapsed? (collapse state is panel-owned.) */
  isCollapsed: (from: number) => boolean;
  /** Flip a heading's collapse state (the panel mutates the set, then re-syncs
   *  visibility + focus). Left/Right expand/collapse route through here. */
  toggleCollapse: (from: number) => void;
  /** Jump the editor selection to a heading (Enter). Selection-only. */
  jumpTo: (heading: OutlineHeading) => void;
  /** Hand focus back to the editor when the tree is now empty and can no longer
   *  hold focus — mirrors setOpen's hadOutlineFocus rescue. */
  focusEditor: () => void;
};

/** The mounted tree-nav. The panel constructs one in its constructor, hands over
 *  freshly-built rows on every render (`setRows`), reads them back through the
 *  read-only `rows` getter, and drives the roving tab stop / focus restoration
 *  through the remaining methods. */
export type TreeNav = {
  /** Read-only view of the rendered rows — the panel's refreshVisibility /
   *  updateActive read this; only setRows (this module) replaces it. */
  readonly rows: readonly RowRef[];
  /** Replace the stored rows after a renderList rebuild. Copies the array so the
   *  caller's reference can never mutate TreeNav's stored rows (sole ownership
   *  enforced mechanically, not by convention). */
  setRows(next: readonly RowRef[]): void;
  /** Promote exactly one row to `tabindex="0"` (the sole tab stop into the tree);
   *  demote the rest to `-1`. Null clears every row to `-1` (empty list). */
  setTabbable(from: number | null): void;
  /** `from` of the first visible row, or null when none are visible. */
  firstVisibleFrom(): number | null;
  /** If the tab stop landed on a now-hidden (or removed) row, move it to the
   *  first visible row so Tab always reaches a real, visible node. */
  ensureTabbableVisible(): void;
  /** `from` of the row that currently holds DOM focus, or null when focus is not
   *  on a tree row (live-focus gated) — read before a mutation that may hide or
   *  replace rows so restoreRowFocus can re-home focus onto the surviving row. */
  focusedRowFrom(): number | null;
  /** Re-home focus after a mutation that may have hidden or replaced the focused
   *  row. No-op when `from` is null (focus was not on a row). */
  restoreRowFocus(from: number | null): void;
  /** Record the row that just gained focus (the roving focus offset) so a later
   *  rebuild can re-home focus onto this exact heading. Called from the panel's
   *  focusin handler; the sole writer of pendingFocusedFrom besides remapFocus. */
  noteFocusedRow(from: number): void;
  /** Map the tracked focused offset through a document edit via the supplied
   *  position-mapper, so a rebuild triggered by an edit that shifts the focused
   *  heading re-homes onto it, not the first-row fallback. The panel supplies the
   *  mapper (`(from) => u.changes.mapPos(from, 1)` — assoc +1: follow the heading,
   *  not text inserted at its start), keeping the CodeMirror API on the panel side. */
  remapFocus(mapPos: (from: number) => number): void;
};

export function createTreeNav(deps: TreeNavDeps): TreeNav {
  const { listEl } = deps;

  /** Rendered rows for post-render visibility refresh — replaced wholesale on
   *  each renderList via setRows; the panel reads them through the getter. */
  let rows: RowRef[] = [];
  /** `from` of the row that currently holds `tabindex="0"` — the single tab stop
   *  into the tree (roving tabindex). All other visible rows are `tabindex="-1"`,
   *  reachable only via the arrow-key handlers. Null while the list is empty. */
  let tabbableFrom: number | null = null;
  /** `from` of the row a keyboard user last focused, kept in the CURRENT
   *  document's coordinate space by remapFocus (same assoc +1 as the panel's
   *  collapse offsets). Set on `focusin` (noteFocusedRow) and read — only while
   *  focus is still live inside the tree — by focusedRowFrom() so a rebuild
   *  re-homes focus onto that exact heading even when an edit shifted its offset.
   *  A stale value (focus since moved to the editor) is harmless: the live-focus
   *  gate in focusedRowFrom() ignores it. */
  let pendingFocusedFrom: number | null = null;

  /** `from` of the first visible row, or null when none are visible. */
  function firstVisibleFrom(): number | null {
    const row = rows.find((r) => !r.li.hidden);
    return row !== undefined ? row.heading.from : null;
  }

  /** Promote exactly one row to `tabindex="0"` (the sole tab stop into the tree);
   *  demote the rest to `-1`. Null clears every row to `-1` (empty list). */
  function setTabbable(from: number | null): void {
    tabbableFrom = from;
    for (const row of rows) {
      row.li.tabIndex = row.heading.from === from ? 0 : -1;
    }
  }

  /** If the tab stop landed on a now-hidden (or removed) row, move it to the
   *  first visible row so Tab always reaches a real, visible node. */
  function ensureTabbableVisible(): void {
    if (tabbableFrom === null) {
      return;
    }
    const row = rows.find((r) => r.heading.from === tabbableFrom);
    if (row === undefined || row.li.hidden) {
      setTabbable(firstVisibleFrom());
    }
  }

  /** `from` of the row that currently holds DOM focus, or null when focus is not
   *  on a tree row. Read BEFORE a mutation that may hide (refreshVisibility) or
   *  replace (renderList) rows, so `restoreRowFocus` can re-home focus onto the
   *  equivalent surviving row — a hidden or removed focused row otherwise strands
   *  DOM focus on `<body>` (the browser blurs it), silently breaking keyboard
   *  navigation. Two guards, both essential:
   *   - the LIVE `activeElement` check keeps this null whenever focus is NOT in
   *     the tree (typing in the editor with the sidebar open), so restore is a
   *     no-op and never pulls focus INTO the tree unbidden;
   *   - the value comes from `pendingFocusedFrom` (set on `focusin`, remapped
   *     through edits by remapFocus), NOT from stale `rows` — so an edit that
   *     shifted the focused heading's offset still yields its CURRENT `from`
   *     and restore matches it exactly rather than falling to the first row. */
  function focusedRowFrom(): number | null {
    if (!listEl.contains(document.activeElement)) {
      return null;
    }
    return pendingFocusedFrom;
  }

  /** Re-home focus after a mutation that may have hidden or replaced the focused
   *  row. Prefers the same heading (by `from`) when it survived and is visible;
   *  otherwise the nearest visible row above its old position (for a collapse,
   *  the collapsed ancestor); then the first visible row when the heading vanished
   *  entirely (a rebuild dropped it); and finally the editor when the tree is now
   *  empty — so focus is never left stranded on `<body>`. No-op when `from` is
   *  null (focus was not on a row) so it never steals focus into the tree. */
  function restoreRowFocus(from: number | null): void {
    if (from === null) {
      return;
    }
    const idx = rows.findIndex((r) => r.heading.from === from);
    if (idx !== -1 && !rows[idx].li.hidden) {
      focusRow(rows[idx]); // same heading survived & is visible
      return;
    }
    if (idx !== -1) {
      for (let i = idx - 1; i >= 0; i--) {
        if (!rows[i].li.hidden) {
          focusRow(rows[i]); // nearest visible ancestor / predecessor
          return;
        }
      }
    }
    const first = rows.find((r) => !r.li.hidden);
    if (first !== undefined) {
      focusRow(first);
      return;
    }
    // The tree is now empty (every heading removed): nothing inside it can hold
    // focus, so hand focus back to the editor rather than stranding it on <body>,
    // mirroring setOpen's hadOutlineFocus rescue on close.
    deps.focusEditor();
  }

  /** Move the tab stop to a row and focus it — the shared move for every
   *  arrow-key / Home / End navigation. */
  function focusRow(row: RowRef): void {
    setTabbable(row.heading.from);
    row.li.focus();
  }

  /** Focus the nearest visible row in `dir` from `idx` (no wrap). */
  function focusRelative(idx: number, dir: 1 | -1): void {
    for (let i = idx + dir; i >= 0 && i < rows.length; i += dir) {
      if (!rows[i].li.hidden) {
        focusRow(rows[i]);
        return;
      }
    }
  }

  function onListKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const li = target?.closest<HTMLLIElement>(".quoll-outline-row") ?? null;
    if (li === null) {
      return;
    }
    const idx = rows.findIndex((r) => r.li === li);
    if (idx === -1) {
      return;
    }
    const row = rows[idx];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRelative(idx, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRelative(idx, -1);
        break;
      case "Home":
        e.preventDefault();
        focusRelative(-1, 1); // first visible: scan forward from before row 0
        break;
      case "End":
        e.preventDefault();
        focusRelative(rows.length, -1); // last visible: scan back from the end
        break;
      case "ArrowRight":
        e.preventDefault();
        onArrowRight(idx, row);
        break;
      case "ArrowLeft":
        e.preventDefault();
        onArrowLeft(idx, row);
        break;
      case "Enter":
        e.preventDefault();
        deps.jumpTo(row.heading);
        break;
      default:
        // Everything else (incl. Escape, handled by the sidebar) bubbles on.
        break;
    }
  }

  /** Right: expand a collapsed parent (focus stays); on an already-expanded
   *  parent, dive to the first child; a leaf does nothing. */
  function onArrowRight(idx: number, row: RowRef): void {
    if (!row.hasChildren) {
      return;
    }
    if (deps.isCollapsed(row.heading.from)) {
      deps.toggleCollapse(row.heading.from); // expand in place; re-homes focus itself
    } else {
      // Expanded ⇒ the next row is this parent's first child (build order).
      focusRelative(idx, 1);
    }
  }

  /** Left: collapse an expanded parent (focus stays); otherwise climb to the
   *  parent row (nearest shallower visible ancestor). */
  function onArrowLeft(idx: number, row: RowRef): void {
    if (row.hasChildren && !deps.isCollapsed(row.heading.from)) {
      deps.toggleCollapse(row.heading.from); // collapse in place; re-homes focus itself
      return;
    }
    const depth = row.heading.depth;
    for (let i = idx - 1; i >= 0; i--) {
      if (!rows[i].li.hidden && rows[i].heading.depth < depth) {
        focusRow(rows[i]);
        return;
      }
    }
  }

  // Keyboard tree model (WAI-ARIA tree-view pattern): one delegated handler on
  // the list — focus lives on a row <li> (roving tabindex), so every arrow /
  // Home / End / Enter keydown bubbles here. Delegation survives every rebuild
  // (the list element persists; only its rows are replaced).
  listEl.addEventListener("keydown", onListKeydown);

  return {
    get rows(): readonly RowRef[] {
      return rows;
    },
    setRows(next: readonly RowRef[]): void {
      // Copy: the caller's array reference must not alias TreeNav's stored rows,
      // so a later push/splice on the caller's side cannot mutate our state.
      rows = [...next];
    },
    setTabbable,
    firstVisibleFrom,
    ensureTabbableVisible,
    focusedRowFrom,
    restoreRowFocus,
    noteFocusedRow(from: number): void {
      pendingFocusedFrom = from;
    },
    remapFocus(mapPos: (from: number) => number): void {
      if (pendingFocusedFrom !== null) {
        pendingFocusedFrom = mapPos(pendingFocusedFrom);
      }
    },
  };
}
