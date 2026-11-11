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

/** Emit markers with an open-stack. At each unit, close from the top of the stack
 *  down to the deepest open style the unit does not carry, then open the styles it
 *  is missing, the one that runs furthest outermost (so `***A**B***C**`, not a
 *  close-and-reopen per element). A NEUTRAL unit never opens anything: an opener
 *  right before whitespace is not left-flanking, so it is emitted with whatever is
 *  still open and its missing styles open at the next non-neutral unit
 *  (`**a*a*** *a*`, not `**a*a**** a*`). */
function emit(units: readonly Unit[], styles: readonly StyleMask[], opts: InlineRunOptions) {
  let out = "";
  const stack: StyleMask[] = [];
  let emittedSyntax = false;
  const closeTo = (depth: number): void => {
    while (stack.length > depth) {
      out += MARKER[stack.pop() as StyleMask];
    }
  };
  units.forEach((u, i) => {
    if (u.kind === "link" && u.labelSyntax) {
      emittedSyntax = true;
    }
    const target = styles[i];
    const deepest = stack.findIndex((s) => !(target & s));
    if (deepest >= 0) {
      closeTo(deepest);
    }
    if (!isNeutral(u)) {
      const missing = STYLES.filter((s) => target & s && !stack.includes(s)).sort(
        (a, b) => extent(styles, i, b) - extent(styles, i, a)
      );
      for (const s of missing) {
        out += MARKER[s];
        stack.push(s);
        emittedSyntax = true;
      }
    }
    out += render(u, opts);
  });
  closeTo(0);
  return { markdown: out, emittedSyntax };
}

/** Serialise styled inline atoms to Markdown. Pure: no DOM, no logging. */
export function serializeInlineRuns(
  atoms: readonly InlineAtom[],
  opts: InlineRunOptions
): InlineRunResult {
  let units = toUnits(atoms, opts);
  if (opts.trimEdges) {
    units = trimUnits(units);
  }
  return emit(units, effectiveStyles(units), opts);
}
