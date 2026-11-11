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

export interface InlineRunOptions {
  /** Trim leading/trailing whitespace and break units (a block's edges). */
  readonly trimEdges: boolean;
  /** Escapes a text unit so it renders literally (the converter's `escapeInline`,
   *  injected so this module has no import from the converter). */
  readonly escapeText: (s: string) => string;
  readonly maxRepairs?: number;
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

/** A hard break cannot live in a link label (the newline would end the link), so a
 *  label's break atoms become one space each, keeping their style. */
function foldLabelBreaks(label: readonly InlineAtom[]): InlineAtom[] {
  return label.map((a) => (a.kind === "break" ? { kind: "text", text: " ", style: a.style } : a));
}

function linkUnit(
  label: InlineAtom[],
  destination: string,
  style: StyleMask,
  opts: InlineRunOptions
): LinkUnit {
  // `trimEdges: false`: label-edge spaces are not block edges; the converter has
  // always kept them (`[ x ](u)`).
  const inner = serializeInlineRuns(foldLabelBreaks(label), { ...opts, trimEdges: false });
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
            const neutral = WHITESPACE_RUN.test(piece) || INVISIBLE_TOKEN.test(piece);
            units.push({ kind: "text", text: piece, style: atom.style, neutral });
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

/** Effective style per unit. A neutral unit keeps only the styles shared by its own
 *  source style and the nearest non-neutral unit on each side (a missing side is 0):
 *  an interior space keeps its style, while a space at a run edge drops the style
 *  that cannot end on whitespace (CommonMark flanking). */
function effectiveStyles(units: readonly Unit[]): StyleMask[] {
  const n = units.length;
  const before: StyleMask[] = new Array(n).fill(0);
  const after: StyleMask[] = new Array(n).fill(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    before[i] = last;
    if (!isNeutral(units[i])) {
      last = units[i].style;
    }
  }
  last = 0;
  for (let i = n - 1; i >= 0; i--) {
    after[i] = last;
    if (!isNeutral(units[i])) {
      last = units[i].style;
    }
  }
  return units.map((u, i) => (isNeutral(u) ? u.style & before[i] & after[i] : u.style));
}

function render(u: Unit, opts: InlineRunOptions): string {
  switch (u.kind) {
    case "text":
      return opts.escapeText(u.text);
    case "code":
      return u.markdown;
    case "break":
      return HARD_BREAK;
    case "link":
      return `[${u.labelMarkdown}](${u.destination})`;
  }
}

const MARKER: Record<number, string> = { [BOLD]: "**", [ITALIC]: "*" };
const STYLES = [BOLD, ITALIC] as const;

/** How many consecutive units, starting at `from`, carry style `s`. */
function extent(styles: readonly StyleMask[], from: number, s: StyleMask): number {
  let i = from;
  while (i < styles.length && styles[i] & s) {
    i++;
  }
  return i - from;
}

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

/** Emit markers with an open-stack. At each unit, close from the top of the stack
 *  down to the deepest open style the unit does not carry, then open the styles it
 *  is missing, the one that runs furthest outermost (so `***A**B***C**`, not a
 *  close-and-reopen per element). A NEUTRAL unit never opens anything: an opener
 *  right before whitespace is not left-flanking, so it is emitted with whatever is
 *  still open and its missing styles open at the next non-neutral unit
 *  (`**a*a*** *a*`, not `**a*a**** a*`). */
function emit(
  units: readonly Unit[],
  styles: readonly StyleMask[],
  opts: InlineRunOptions
): Emission {
  let out = "";
  const stack: StyleMask[] = [];
  const groups: MarkerGroup[] = [];
  let emittedSyntax = false;
  const boundary = (at: number, closeDepth: number, opens: readonly StyleMask[]): void => {
    const from = out.length;
    const hasClose = stack.length > closeDepth;
    while (stack.length > closeDepth) {
      out += MARKER[stack.pop() as StyleMask];
    }
    for (const s of opens) {
      out += MARKER[s];
      stack.push(s);
    }
    if (out.length > from) {
      emittedSyntax = true;
      groups.push({ from, to: out.length, at, hasOpen: opens.length > 0, hasClose });
    }
  };
  units.forEach((u, i) => {
    if (u.kind === "link" && u.labelSyntax) {
      emittedSyntax = true;
    }
    const target = styles[i];
    const deepest = stack.findIndex((s) => !(target & s));
    const closeDepth = deepest >= 0 ? deepest : stack.length;
    const kept = stack.slice(0, closeDepth);
    const opens = isNeutral(u)
      ? []
      : STYLES.filter((s) => target & s && !kept.includes(s)).sort(
          (a, b) => extent(styles, i, b) - extent(styles, i, a)
        );
    boundary(i, closeDepth, opens);
    out += render(u, opts);
  });
  boundary(units.length, 0, []);
  return { markdown: out, emittedSyntax, groups };
}

// ---------------------------------------------------------------------------
// Flanking classification — what `@lezer/markdown` 1.6.4 computes, not the spec.
//
// Mirrors `Emphasis()` in @lezer/markdown 1.6.4 (dist/index.js ~1453): the
// parser scans the WHOLE run of `*` before classifying it, so a closer
// immediately followed by an opener is one delimiter run with one pair of
// neighbours. The neighbours are single UTF-16 code units (`cx.slice(start - 1,
// start)`), whitespace is JS `\s` or the string edge, and punctuation is
// `/[\p{S}|\p{P}]/u` on that one unit — so a surrogate half is neither, and
// every astral code point is a word character. src/webview/cm/inline/inline-ir.ts
// deliberately models the SPEC (whole code points, Unicode Zs whitespace) for
// rendering; it is not shared, because what matters here is how the editor's own
// parser will re-read the bytes. Pinned to 1.6.4 only: a Lezer bump that changes
// the classification is caught by the re-parse oracle tests.
//
// Not modelled: the rule of three in Lezer's `resolveMarkers` (~1720), a MATCHING
// rule rather than a flanking one. Lezer's resolveMarkers recomputes closeSize
// from the spliced leftover delimiter (dist/index.js ~1706-1720), so the
// emitter's run shapes never hit a rule-of-3 block; there is no repair branch for
// it. The nested-emission invariant and the re-parse oracle corpus are the checks
// on that omission.
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

/** Repair (b), punctuation demotion: the punctuation next to the failing group is
 *  the edge char of a non-neutral text unit. Split that char into its own NEUTRAL
 *  unit — it then takes the intersection style of rule 2 and the markers move past
 *  it — but only while the unit's run (the contiguous units of the same effective
 *  style) keeps a non-punctuation, non-neutral char, so a run is never demoted down
 *  to nothing. A demoted unit is neutral and so is never demoted again. */
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
      return hasWordChar(rest);
    }
    const v = units[j];
    if (isNeutral(v)) {
      return false;
    }
    return v.kind !== "text" || hasWordChar(v.text);
  };
  let lo = idx;
  while (lo > 0 && styles[lo - 1] === styles[idx]) {
    lo--;
  }
  let hi = idx;
  while (hi < units.length - 1 && styles[hi + 1] === styles[idx]) {
    hi++;
  }
  let kept = false;
  for (let j = lo; j <= hi && !kept; j++) {
    kept = keeps(j);
  }
  if (!kept) {
    return null;
  }
  const demoted: Unit = { kind: "text", text: ch, style: u.style, neutral: true };
  const remaining: Unit[] = rest === "" ? [] : [{ ...u, text: rest }];
  const replacement = edge === "end" ? [...remaining, demoted] : [demoted, ...remaining];
  return [...units.slice(0, idx), ...replacement, ...units.slice(idx + 1)];
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
  const label = u.label.map((a) => ({ ...a, style: (a.style | u.style) as StyleMask }));
  const moved = linkUnit(label, u.destination, 0, opts);
  return [...units.slice(0, idx), moved, ...units.slice(idx + 1)];
}

/** Apply the first applicable repair to the first failing group that has one, in
 *  output order. The link-edge and demotion preconditions are disjoint (a link
 *  unit vs a text unit on the punctuation side), so their order is immaterial. A failing group no branch can repair is skipped unchanged (never
 *  retried). Null when nothing applies — the fixpoint. */
function repairOnce(
  units: readonly Unit[],
  styles: readonly StyleMask[],
  emission: Emission,
  opts: InlineRunOptions
): Unit[] | null {
  for (const g of emission.groups) {
    const side = failingSide(emission.markdown, g);
    if (side === null) {
      continue;
    }
    const punctIdx = side === "before" ? g.at - 1 : g.at;
    const repaired =
      transferLinkStyle(units, punctIdx, opts) ??
      demotePunctuation(units, styles, punctIdx, side === "before" ? "end" : "start");
    if (repaired !== null) {
      return repaired;
    }
  }
  return null;
}

/** Serialise styled inline atoms to Markdown. Pure: no DOM, no logging.
 *
 *  Serialise, find the first marker group that does not flank on the side it
 *  needs, repair it at unit level, and re-serialise from the units, until no
 *  group can be repaired. Each repair is one-way (a link's outer style is cleared,
 *  or one char is demoted), so the loop terminates. */
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
    const repaired = repairOnce(units, styles, emission, opts);
    if (repaired === null) {
      return { markdown: emission.markdown, emittedSyntax: emission.emittedSyntax };
    }
    units = repaired;
  }
}
