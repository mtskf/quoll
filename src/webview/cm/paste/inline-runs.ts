// Pure, DOM-free half of the rich-paste inline serializer: a flat list of styled
// atoms (collected from the clipboard DOM by `collectInline` in
// html-to-markdown.ts) → a Markdown fragment.
//
// Why a flat IR instead of wrapping child strings: emphasis is a property of
// CHARACTERS, while CommonMark's delimiter rules are a property of the bytes
// around each marker. Wrapping each element's serialised children in its own
// markers emitted one marker pair per DOM element, so adjacent or overlapping
// `<b>`/`<i>` produced runs like `**A****B**` that re-parse as something else.
// Resolving styles per character first and emitting markers per same-style run
// makes the marker layout a function of the styled text alone, independent of
// how the producer happened to nest its tags.
//
// Pipeline: atoms → units (text split at whitespace runs) → effective style per
// unit (neutral units take the intersection with their neighbours) → marker
// emission.

export const BOLD = 1;
export const ITALIC = 2;
/** Bit set of `BOLD` / `ITALIC` (0..3). */
export type StyleMask = number;

/** One piece of inline content with its ABSOLUTE style mask (except link labels,
 *  whose masks are relative to the link). Text is whitespace-collapsed and NOT yet
 *  escaped; `code` is an already-fenced inline-code span emitted verbatim. */
export type InlineAtom =
  | { kind: "text"; text: string; style: StyleMask }
  | { kind: "code"; markdown: string; style: StyleMask }
  | { kind: "link"; label: InlineAtom[]; destination: string; style: StyleMask }
  | { kind: "break"; style: StyleMask };

/** The hard-break token emitted for a `break` atom: a backslash immediately
 *  followed by a newline (the backslash form survives line-end trimming, unlike
 *  two trailing spaces). The single declaration of the token. */
export const HARD_BREAK = "\\\n";

/** A conversion bound was hit; the converter falls back to plain text. Lives here
 *  (not in the converter) so the converter imports it one way and its existing
 *  `instanceof CapExceeded` checks see this serializer's error too. */
export class CapExceeded extends Error {}

/** The flanking repair loop ran past its budget. A `CapExceeded`, so it takes the
 *  same plain-text fallback; its own class so the converter can warn about it. */
export class InlineRepairCapExceeded extends CapExceeded {}

/** Repair work left for one whole conversion, in chars re-serialised. Shared by
 *  every call so the total stays bounded: each repair re-serialises its whole run,
 *  so a per-call cap would still let many repairs over a long run go quadratic. */
export interface RepairBudget {
  remaining: number;
}

export interface InlineRunOptions {
  /** Trim leading/trailing whitespace and break units (a block's edges). */
  readonly trimEdges: boolean;
  /** Escapes a text unit so it renders literally (the converter's `escapeInline`,
   *  injected so this module has no import from the converter). */
  readonly escapeText: (s: string) => string;
  /** Charged by each repair; running out throws `InlineRepairCapExceeded`. */
  readonly repairBudget: RepairBudget;
}

export interface InlineRunResult {
  readonly markdown: string;
  /** True iff the output contains an emphasis marker this serializer emitted.
   *  Code and link syntax are flagged by the collector, which owns those gates. */
  readonly emittedSyntax: boolean;
}

type Unit =
  | { kind: "text"; text: string; style: StyleMask; neutral: boolean }
  | { kind: "code"; markdown: string; style: StyleMask }
  | { kind: "break"; style: StyleMask }
  /** Repair (c)'s `&#N;`, standing in for one code point of a text unit and
   *  carrying that unit's style. Non-neutral, emitted verbatim (never escaped), and
   *  never a demotion or re-encoding candidate. */
  | { kind: "entity"; text: string; style: StyleMask }
  | LinkUnit;

/** A link is ONE opaque, non-neutral unit of the outer run (brackets bind tighter
 *  than emphasis); its label is serialised on its own by the same function. */
interface LinkUnit {
  kind: "link";
  label: InlineAtom[];
  destination: string;
  style: StyleMask;
  /** The serialised label (`[${…}](…)` body) and whether it emitted markers. */
  labelMarkdown: string;
  labelSyntax: boolean;
}

/** A token holding only `\p{Default_Ignorable_Code_Point} ∪ \p{Cf}` chars — what the
 *  converter's `blankAfterInvisible` calls blank for a whitespace-free token (a lone
 *  joiner). Visually empty, so it must not carry markers on its own. */
const INVISIBLE_TOKEN = /^(?:\p{Default_Ignorable_Code_Point}|\p{Cf})+$/u;
const WHITESPACE_RUN = /^\s+$/;

/** Turn each top-level break atom into one space, keeping its style — for content
 *  that cannot hold a hard break: a link label (the newline would end the link) or
 *  a heading (single-line). */
export function foldBreaksToSpaces(atoms: readonly InlineAtom[]): InlineAtom[] {
  return atoms.map((a) => (a.kind === "break" ? { kind: "text", text: " ", style: a.style } : a));
}

/** A text unit, neutral iff it is a whitespace run or an invisible-only token. The
 *  constructor for text units and demotion remainders, which re-derive neutrality
 *  from their own text instead of inheriting the parent's: a lone joiner left
 *  behind must not carry markers on its own. */
function textUnit(text: string, style: StyleMask): Unit {
  const neutral = WHITESPACE_RUN.test(text) || INVISIBLE_TOKEN.test(text);
  return { kind: "text", text, style, neutral };
}

function linkUnit(
  label: InlineAtom[],
  destination: string,
  style: StyleMask,
  opts: InlineRunOptions
): LinkUnit {
  // `trimEdges: false`: label-edge spaces are not block edges; the converter has
  // always kept them (`[ x ](u)`).
  const inner = serializeInlineRuns(foldBreaksToSpaces(label), { ...opts, trimEdges: false });
  return {
    kind: "link",
    label,
    destination,
    style,
    labelMarkdown: inner.markdown,
    labelSyntax: inner.emittedSyntax,
  };
}

function toUnits(atoms: readonly InlineAtom[], opts: InlineRunOptions): Unit[] {
  const units: Unit[] = [];
  for (const atom of atoms) {
    switch (atom.kind) {
      case "text":
        for (const piece of atom.text.split(/(\s+)/)) {
          if (piece !== "") {
            units.push(textUnit(piece, atom.style));
          }
        }
        break;
      case "code":
        units.push({ kind: "code", markdown: atom.markdown, style: atom.style });
        break;
      case "break":
        units.push({ kind: "break", style: atom.style });
        break;
      case "link":
        units.push(linkUnit(atom.label, atom.destination, atom.style, opts));
        break;
    }
  }
  return units;
}

function isNeutral(u: Unit): boolean {
  return u.kind === "break" || (u.kind === "text" && u.neutral);
}

/** A unit a block edge drops: whitespace or a break (a lone joiner is kept, as the
 *  converter always has). */
function isEdgeTrimmable(u: Unit): boolean {
  return u.kind === "break" || (u.kind === "text" && WHITESPACE_RUN.test(u.text));
}

function trimUnits(units: Unit[]): Unit[] {
  let start = 0;
  let end = units.length;
  while (start < end && isEdgeTrimmable(units[start])) {
    start++;
  }
  while (end > start && isEdgeTrimmable(units[end - 1])) {
    end--;
  }
  return units.slice(start, end);
}

/** Effective style per unit. Each maximal stretch of consecutive neutral units
 *  takes ONE style: the styles shared by every unit's own source style in the
 *  stretch and the nearest non-neutral unit on each side (a missing side is 0). An
 *  interior space keeps its style, while a space at a run edge drops the style that
 *  cannot end on whitespace (CommonMark flanking). Uniform per stretch so a closer
 *  only ever lands at the stretch's first unit, right after a non-neutral one —
 *  never after a styled space that a differently styled neutral follows. */
function effectiveStyles(units: readonly Unit[]): StyleMask[] {
  const styles = units.map((u) => u.style);
  let prev = 0;
  let i = 0;
  while (i < units.length) {
    if (!isNeutral(units[i])) {
      prev = units[i].style;
      i++;
      continue;
    }
    let j = i;
    let shared = prev;
    while (j < units.length && isNeutral(units[j])) {
      shared &= units[j].style;
      j++;
    }
    const next = j < units.length ? units[j].style : 0;
    shared &= next;
    styles.fill(shared === next ? shared : 0, i, j);
    i = j;
  }
  return styles;
}

function render(u: Unit, opts: InlineRunOptions): string {
  switch (u.kind) {
    case "text":
      return opts.escapeText(u.text);
    case "code":
      return u.markdown;
    case "entity":
      return u.text;
    case "break":
      return HARD_BREAK;
    case "link":
      return `[${u.labelMarkdown}](${u.destination})`;
  }
}

const MARKER: Record<number, string> = { [BOLD]: "**", [ITALIC]: "*", [BOLD | ITALIC]: "***" };

/** One maximal run of consecutive emitted `*` delimiters, all emitted at ONE unit
 *  boundary: between unit `at - 1` and unit `at` (`at === units.length` for the
 *  final closes). Provenance for the repair loop. */
interface MarkerGroup {
  from: number;
  to: number;
  at: number;
  hasOpen: boolean;
  hasClose: boolean;
}

interface Emission {
  markdown: string;
  emittedSyntax: boolean;
  groups: MarkerGroup[];
}

/** Emit one complete pair per equal-mask region. Neutral units cannot open a region. */
function emit(
  units: readonly Unit[],
  styles: readonly StyleMask[],
  opts: InlineRunOptions
): Emission {
  let out = "";
  let active = 0;
  const groups: MarkerGroup[] = [];
  let emittedSyntax = false;
  const marker = (mask: StyleMask, at: number, open: boolean): void => {
    const from = out.length;
    out += MARKER[mask];
    groups.push({ from, to: out.length, at, hasOpen: open, hasClose: !open });
    emittedSyntax = true;
  };
  units.forEach((u, i) => {
    if (u.kind === "link" && u.labelSyntax) {
      emittedSyntax = true;
    }
    const target = styles[i];
    const close = active !== 0 && active !== target;
    const open = !isNeutral(u) && target !== 0 && active !== target;
    if (close) {
      marker(active, i, false);
      active = 0;
    }
    if (open) {
      if (close) {
        out += "&#8288;";
      }
      marker(target, i, true);
      active = target;
    }
    // Merging can put a literal exclamation immediately before a link.
    if (u.kind === "link" && out.endsWith("!")) {
      out = `${out.slice(0, -1)}\\!`;
    }
    out += render(u, opts);
  });
  if (active) {
    marker(active, units.length, false);
  }
  return { markdown: out, emittedSyntax, groups };
}

// ---------------------------------------------------------------------------
// Flanking classification shared by the pinned Lezer and CommonMark parsers:
// both inspect UTF-16 code units, use JS whitespace and Unicode punctuation.
// ---------------------------------------------------------------------------

const LEZER_PUNCTUATION = /[\p{S}|\p{P}]/u;

function isSpaceOrEdge(ch: string): boolean {
  return ch === "" || /\s/.test(ch);
}

/** Does `group` fail to flank on a side it needs? Returns which side holds the
 *  punctuation that breaks it: `"before"` for a closer that is not right-flanking
 *  (punctuation before, word after), `"after"` for an opener that is not
 *  left-flanking (punctuation after, word before), or null when it flanks. */
function failingSide(out: string, g: MarkerGroup): "before" | "after" | null {
  const before = out.slice(g.from - 1, g.from);
  const after = out.slice(g.to, g.to + 1);
  const sBefore = isSpaceOrEdge(before);
  const sAfter = isSpaceOrEdge(after);
  const pBefore = LEZER_PUNCTUATION.test(before);
  const pAfter = LEZER_PUNCTUATION.test(after);
  const leftFlanking = !sAfter && (!pAfter || sBefore || pBefore);
  const rightFlanking = !sBefore && (!pBefore || sAfter || pAfter);
  if (g.hasClose && !rightFlanking) {
    return "before";
  }
  if (g.hasOpen && !leftFlanking) {
    return "after";
  }
  return null;
}

/** A word character in the Lezer sense: neither whitespace nor punctuation, per
 *  UTF-16 code unit (so a surrogate half counts as a word character). */
function hasWordChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text[i];
    if (!/\s/.test(unit) && !LEZER_PUNCTUATION.test(unit)) {
      return true;
    }
  }
  return false;
}

/** The inclusive bounds of the contiguous run with the same effective style. */
function runRange(styles: readonly StyleMask[], idx: number): [number, number] {
  let lo = idx;
  while (lo > 0 && styles[lo - 1] === styles[idx]) {
    lo--;
  }
  let hi = idx;
  while (hi < styles.length - 1 && styles[hi + 1] === styles[idx]) {
    hi++;
  }
  return [lo, hi];
}

/** Repair (b), punctuation demotion: the punctuation next to the failing group is
 *  the edge char of a non-neutral text unit. Split that char into its own NEUTRAL
 *  unit — it then takes its neutral stretch's style from `effectiveStyles` and the
 *  markers move past it — but only while the unit's run (the contiguous units of
 *  the same effective style) keeps a non-punctuation, non-neutral char, so a run is
 *  never demoted down to nothing. A demoted unit is neutral and so is never demoted again. */
function demotePunctuation(
  units: readonly Unit[],
  styles: readonly StyleMask[],
  idx: number,
  edge: "start" | "end"
): Unit[] | null {
  const u = units[idx];
  if (u === undefined || u.kind !== "text" || u.neutral) {
    return null;
  }
  const ch = edge === "end" ? u.text[u.text.length - 1] : u.text[0];
  if (!LEZER_PUNCTUATION.test(ch)) {
    return null;
  }
  const rest = edge === "end" ? u.text.slice(0, -1) : u.text.slice(1);
  const keeps = (j: number): boolean => {
    if (j === idx) {
      return hasWordChar(rest) && !isNeutral(textUnit(rest, u.style));
    }
    const v = units[j];
    if (isNeutral(v)) {
      return false;
    }
    return v.kind !== "text" || hasWordChar(v.text);
  };
  const [lo, hi] = runRange(styles, idx);
  let kept = false;
  for (let j = lo; j <= hi && !kept; j++) {
    kept = keeps(j);
  }
  if (!kept) {
    return null;
  }
  const demoted: Unit = { kind: "text", text: ch, style: u.style, neutral: true };
  const remaining: Unit[] = rest === "" ? [] : [textUnit(rest, u.style)];
  return edge === "end" ? [...remaining, demoted] : [demoted, ...remaining];
}

/** Repair (a), link edge: the punctuation next to the failing group is a styled
 *  link's own `[` or `)`. Move the link's outer style into its label (the label
 *  masks are link-relative, so OR it in) and clear the outer style: the markers
 *  then sit inside the brackets, next to the label text, instead of outside them.
 *  The outer style never comes back, so this fires at most once per link. */
function transferLinkStyle(
  units: readonly Unit[],
  idx: number,
  opts: InlineRunOptions
): Unit[] | null {
  const u = units[idx];
  if (u === undefined || u.kind !== "link" || u.style === 0) {
    return null;
  }
  const label = u.label.map((a) => ({ ...a, style: a.style | u.style }));
  return [linkUnit(label, u.destination, 0, opts)];
}

/** Repair (c), entity fallback: nothing on the punctuation side can move (a code
 *  span's backtick, an all-punctuation run, an entity), so change the OTHER side —
 *  replace the word char next to the group with a decimal reference to its code
 *  point. `&` is punctuation, so the group then flanks. The word side is always a
 *  text unit (code spans, links, breaks and entities present punctuation at their
 *  edges); anything else is left alone. */
function encodeWordNeighbour(
  units: readonly Unit[],
  idx: number,
  edge: "start" | "end"
): Unit[] | null {
  const u = units[idx];
  if (u === undefined || u.kind !== "text" || u.text === "") {
    return null;
  }
  const chars = Array.from(u.text);
  const ch = edge === "start" ? chars[0] : chars[chars.length - 1];
  const rest = edge === "start" ? chars.slice(1).join("") : chars.slice(0, -1).join("");
  const entity: Unit = {
    kind: "entity",
    text: `&#${ch.codePointAt(0) as number};`,
    style: u.style,
  };
  const remaining: Unit[] = rest === "" ? [] : [{ ...u, text: rest }];
  return edge === "start" ? [entity, ...remaining] : [...remaining, entity];
}

/** One repair pass: walk the failing groups in output order and repair each with
 *  the first applicable branch, batching every independent repair into ONE
 *  re-serialisation — otherwise k failing groups in a long run (one `Note:` per
 *  line) cost k full passes. Both neighbour units must be untouched; a
 *  punctuation-side repair also requires its whole same-style run untouched,
 *  because demotion reads that run for a surviving styled character. Transfers
 *  and demotions touch the whole run so later repairs re-read its witness on the
 *  next pass. Word-side encoding only touches the two neighbours. The link-edge
 *  and demotion preconditions are disjoint (a link vs a text unit), so their order
 *  is immaterial. A failing group no branch can repair is skipped unchanged.
 *  Null when nothing applies — the fixpoint. */
function repairPass(
  units: readonly Unit[],
  styles: readonly StyleMask[],
  emission: Emission,
  opts: InlineRunOptions
): Unit[] | null {
  const touched = new Set<number>();
  const edits = new Map<number, Unit[]>();
  for (const g of emission.groups) {
    const side = failingSide(emission.markdown, g);
    if (side === null || touched.has(g.at - 1) || touched.has(g.at)) {
      continue;
    }
    const punctIdx = side === "before" ? g.at - 1 : g.at;
    const wordIdx = side === "before" ? g.at : g.at - 1;
    const [lo, hi] = runRange(styles, punctIdx);
    let runTouched = false;
    for (let j = lo; j <= hi && !runTouched; j++) {
      runTouched = touched.has(j);
    }
    if (runTouched) {
      continue;
    }
    const fromPunct =
      transferLinkStyle(units, punctIdx, opts) ??
      demotePunctuation(units, styles, punctIdx, side === "before" ? "end" : "start");
    const [idx, replacement] =
      fromPunct !== null
        ? [punctIdx, fromPunct]
        : [wordIdx, encodeWordNeighbour(units, wordIdx, side === "before" ? "start" : "end")];
    if (replacement === null) {
      continue;
    }
    edits.set(idx, replacement);
    if (fromPunct !== null) {
      for (let j = lo; j <= hi; j++) {
        touched.add(j);
      }
    }
    touched.add(g.at - 1);
    touched.add(g.at);
  }
  if (edits.size === 0) {
    return null;
  }
  return units.flatMap((u, i) => edits.get(i) ?? [u]);
}

/** The chars one serialisation pass renders, so a large code span or link in a
 *  repaired run is charged for every re-render, not as one unit. A text unit is
 *  counted before escaping and a link as its brackets, label and destination. */
function unitCharCount(units: readonly Unit[]): number {
  let n = 0;
  for (const u of units) {
    switch (u.kind) {
      case "text":
      case "entity":
        n += u.text.length;
        break;
      case "code":
        n += u.markdown.length;
        break;
      case "break":
        n += HARD_BREAK.length;
        break;
      case "link":
        n += u.labelMarkdown.length + u.destination.length + 4;
        break;
    }
  }
  return n;
}

/** Serialise styled inline atoms to Markdown. Pure: no DOM, no logging.
 *
 *  Serialise, find the marker groups that do not flank on the side they need,
 *  repair the independent ones at unit level, and re-serialise from the units,
 *  until no group can be repaired. Each repair is one-way (a link's outer style is cleared,
 *  one char is demoted, or one char becomes an entity), so the loop terminates. */
export function serializeInlineRuns(
  atoms: readonly InlineAtom[],
  opts: InlineRunOptions
): InlineRunResult {
  let units = toUnits(atoms, opts);
  if (opts.trimEdges) {
    units = trimUnits(units);
  }
  for (;;) {
    const styles = effectiveStyles(units);
    const emission = emit(units, styles, opts);
    const repaired = repairPass(units, styles, emission, opts);
    if (repaired === null) {
      return { markdown: emission.markdown, emittedSyntax: emission.emittedSyntax };
    }
    // Charge the re-serialisation this pass forces (at least 1, so even an
    // empty run cannot loop for free).
    opts.repairBudget.remaining -= Math.max(1, unitCharCount(repaired));
    if (opts.repairBudget.remaining < 0) {
      throw new InlineRepairCapExceeded("inline emphasis repair cap exceeded");
    }
    units = repaired;
  }
}
