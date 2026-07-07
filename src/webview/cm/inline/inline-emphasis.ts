// CommonMark §6.2/§6.4 emphasis resolver for inline content. The neutral
// inline tokenizer (inline-ir.ts) emits a flat `Segment<L>[]` — literal text,
// opaque leaves (links / images / autolinks / code spans / escapes carrying
// their boundary spans), and emphasis delimiter runs with their left/right-
// flanking flags precomputed from the surrounding source characters. This
// module owns ONLY emphasis matching + final IR emission; it is DOM-free and
// never inspects URLs or Markdown syntax.
//
// `resolveInline` is a port of the CommonMark reference `processEmphasis`
// (commonmark.js inlines.js): a delimiter stack over a doubly-linked inline
// list, with the rule of 3 (`oddMatch`) and the `openers_bottom` lower-bound
// optimisation. Unmatched delimiter characters survive as literal text nodes.
// Adjacent text nodes are NOT merged — merging is the renderer's job so that
// PR2 can map each span independently.

// A half-open [from, to) range into the parser input string.
export interface Span {
  readonly from: number;
  readonly to: number;
}

// Generic input segment. `L` is the opaque leaf type (e.g. `CellLeaf` in the
// tokenizer; `string` in engine unit tests). The engine never inspects `L`.
export type Segment<L> =
  | { readonly kind: "text"; readonly value: string; readonly span: Span }
  | { readonly kind: "leaf"; readonly leaf: L; readonly span: Span }
  | {
      readonly kind: "delim";
      readonly ch: "*" | "_";
      readonly span: Span;
      readonly canOpen: boolean;
      readonly canClose: boolean;
    };

// Resolved output — a flat or tree-structured IR with no DOM.
export type Resolved<L> =
  | { readonly kind: "text"; readonly value: string; readonly span: Span }
  | { readonly kind: "leaf"; readonly leaf: L; readonly span: Span }
  | {
      readonly kind: "emphasis";
      readonly tag: "em" | "strong";
      readonly openDelim: Span; // the consumed opening delimiter characters
      readonly closeDelim: Span; // the consumed closing delimiter characters
      readonly span: Span; // openDelim.from .. closeDelim.to (outer)
      readonly children: Resolved<L>[];
    };

// ── Internal mutable doubly-linked list ──────────────────────────────────────
// A "wrap" node is an em/strong container produced by emphasis matching;
// its children are a nested list (childHead/childTail).

type Inline<L> =
  | { kind: "text"; prev: Inline<L> | null; next: Inline<L> | null; value: string; span: Span }
  | { kind: "node"; prev: Inline<L> | null; next: Inline<L> | null; leaf: L; span: Span }
  | {
      kind: "wrap";
      prev: Inline<L> | null;
      next: Inline<L> | null;
      tag: "em" | "strong";
      openDelim: Span;
      closeDelim: Span;
      span: Span;
      childHead: Inline<L> | null;
      childTail: Inline<L> | null;
    };

type InlineText<L> = Extract<Inline<L>, { kind: "text" }>;
type InlineNode<L> = Extract<Inline<L>, { kind: "node" }>;
type InlineWrap<L> = Extract<Inline<L>, { kind: "wrap" }>;

function makeText<L>(value: string, span: Span): InlineText<L> {
  return { kind: "text", prev: null, next: null, value, span };
}

function makeNode<L>(leaf: L, span: Span): InlineNode<L> {
  return { kind: "node", prev: null, next: null, leaf, span };
}

function makeWrap<L>(
  tag: "em" | "strong",
  openDelim: Span,
  closeDelim: Span,
  span: Span
): InlineWrap<L> {
  return {
    kind: "wrap",
    prev: null,
    next: null,
    tag,
    openDelim,
    closeDelim,
    span,
    childHead: null,
    childTail: null,
  };
}

// Delimiter-stack entry (doubly-linked). `inline` is the text node holding the
// run's literal characters, so unconsumed delimiters render verbatim as text.
interface Delimiter<L> {
  inline: Extract<Inline<L>, { kind: "text" }>;
  ch: string;
  length: number; // remaining (unconsumed) delimiters
  origLength: number; // run length at tokenization (drives the rule of 3)
  canOpen: boolean;
  canClose: boolean;
  prev: Delimiter<L> | null;
  next: Delimiter<L> | null;
}

export function resolveInline<L>(segments: Segment<L>[]): Resolved<L>[] {
  let head: Inline<L> | null = null;
  let tail: Inline<L> | null = null;
  let delimBottom: Delimiter<L> | null = null;
  let delimTop: Delimiter<L> | null = null;

  const append = (inl: Inline<L>): void => {
    inl.prev = tail;
    if (tail) {
      tail.next = inl;
    } else {
      head = inl;
    }
    tail = inl;
  };

  for (const seg of segments) {
    if (seg.kind === "text") {
      append(makeText(seg.value, seg.span));
    } else if (seg.kind === "leaf") {
      append(makeNode(seg.leaf, seg.span));
    } else {
      // delim: build a text inline holding the literal delimiter chars + a
      // Delimiter stack entry pointing at it.
      const runLen = seg.span.to - seg.span.from;
      const inl = makeText<L>(seg.ch.repeat(runLen), seg.span);
      append(inl);
      const d: Delimiter<L> = {
        inline: inl,
        ch: seg.ch,
        length: runLen,
        origLength: runLen,
        canOpen: seg.canOpen,
        canClose: seg.canClose,
        prev: delimTop,
        next: null,
      };
      if (delimTop) {
        delimTop.next = d;
      } else {
        delimBottom = d;
      }
      delimTop = d;
    }
  }

  processEmphasis(delimBottom);
  return toResolved(head);
}

function processEmphasis<L>(bottom: Delimiter<L> | null): void {
  // CommonMark's openers_bottom optimisation: the lowest opener still worth
  // searching for a given closer. Together with `oddMatch` it enforces the
  // rule of 3. See `slot` below for why each delimiter char needs 6 bottoms.
  const openersBottom: Record<string, Array<Delimiter<L> | null>> = {
    "*": [null, null, null, null, null, null],
    _: [null, null, null, null, null, null],
  };
  // Slot index: a SEPARATE lower bound per (run-length mod 3) AND per "can this
  // closer also open?". The second split is essential — a closer that can also
  // open (e.g. the inner `*` of `**a*a*a*`) fails its own opener search via the
  // rule of 3, but that failure must NOT poison the bound used by a later
  // close-only closer for the same length-mod-3, or nested cases regress
  // (`**a*a*a*` would wrongly yield `**a<em>a</em>a*` instead of the correct
  // `*<em>a<em>a</em>a</em>`). 6 slots = 3 (mod 3) × 2 (canOpen). Mirrors the
  // reference parsers' `(canOpen ? 3 : 0) + length % 3`.
  const slot = (d: Delimiter<L>): number => (d.canOpen ? 3 : 0) + (d.origLength % 3);

  let closer = bottom;
  while (closer !== null) {
    if (!closer.canClose) {
      closer = closer.next;
      continue;
    }
    const ch = closer.ch;
    const lowerBound = openersBottom[ch][slot(closer)];

    let opener = closer.prev;
    let openerFound = false;
    while (opener !== null && opener !== lowerBound) {
      // Rule of 3: if either delimiter can both open and close, a match is
      // disallowed when the closer's run length is not a multiple of 3 but the
      // two run lengths sum to a multiple of 3.
      const oddMatch =
        (closer.canOpen || opener.canClose) &&
        closer.origLength % 3 !== 0 &&
        (opener.origLength + closer.origLength) % 3 === 0;
      if (opener.ch === ch && opener.canOpen && !oddMatch) {
        openerFound = true;
        break;
      }
      opener = opener.prev;
    }

    const oldCloser = closer;

    if (openerFound && opener !== null) {
      const useDelims = closer.length >= 2 && opener.length >= 2 ? 2 : 1;
      wrapBetween(opener, closer, useDelims === 2 ? "strong" : "em", useDelims);
      opener.length -= useDelims;
      closer.length -= useDelims;
      removeDelimitersBetween(opener, closer);
      if (opener.length === 0) {
        removeDelimiter(opener);
      }
      if (closer.length === 0) {
        const next = closer.next;
        removeDelimiter(closer);
        closer = next;
      }
    } else {
      closer = closer.next;
    }

    if (!openerFound) {
      // No opener for this closer at or above the bound — tighten the bound and
      // drop the closer if it can never act as an opener either.
      openersBottom[ch][slot(oldCloser)] = oldCloser.prev;
      if (!oldCloser.canOpen) {
        removeDelimiter(oldCloser);
      }
    }
  }
}

function wrapBetween<L>(
  opener: Delimiter<L>,
  closer: Delimiter<L>,
  tag: "em" | "strong",
  useDelims: number
): void {
  // Span threading: the opener run currently spans [os, oe) and the closer run
  // spans [cs, ce). Consuming `useDelims` characters from the INNER side of each:
  //   openDelim  = [oe - useDelims, oe)   (the chars actually consumed for the wrap)
  //   remaining opener text span = [os, oe - useDelims)
  //   closeDelim = [cs, cs + useDelims)
  //   remaining closer text span = [cs + useDelims, ce)
  //   wrap span  = [openDelim.from, closeDelim.to)
  const openerInl = opener.inline;
  const closerInl = closer.inline;

  const os = openerInl.span.from;
  const oe = openerInl.span.to;
  const cs = closerInl.span.from;
  const ce = closerInl.span.to;

  const openDelim: Span = { from: oe - useDelims, to: oe };
  const closeDelim: Span = { from: cs, to: cs + useDelims };
  const wrapSpan: Span = { from: openDelim.from, to: closeDelim.to };

  // Trim the backing text value to match the remaining span.
  openerInl.value = openerInl.value.slice(0, openerInl.value.length - useDelims);
  openerInl.span = { from: os, to: oe - useDelims };

  closerInl.value = closerInl.value.slice(useDelims);
  closerInl.span = { from: cs + useDelims, to: ce };

  const wrap = makeWrap<L>(tag, openDelim, closeDelim, wrapSpan);

  // Splice the nodes between opener and closer into wrap's child list.
  let cur = openerInl.next;
  while (cur !== null && cur !== closerInl) {
    const nxt = cur.next;
    appendChild(wrap, cur);
    cur = nxt;
  }

  openerInl.next = wrap;
  wrap.prev = openerInl;
  wrap.next = closerInl;
  closerInl.prev = wrap;
}

function appendChild<L>(wrap: InlineWrap<L>, child: Inline<L>): void {
  child.prev = wrap.childTail;
  child.next = null;
  if (wrap.childTail) {
    wrap.childTail.next = child;
  } else {
    wrap.childHead = child;
  }
  wrap.childTail = child;
}

function removeDelimiter<L>(d: Delimiter<L>): void {
  if (d.prev) {
    d.prev.next = d.next;
  }
  if (d.next) {
    d.next.prev = d.prev;
  }
  // Null the unlinked entry's own pointers so a stale reference can never walk
  // back into the live stack. Callers always read `.next`/`.prev` BEFORE removing.
  d.prev = null;
  d.next = null;
}

function removeDelimitersBetween<L>(opener: Delimiter<L>, closer: Delimiter<L>): void {
  if (opener.next !== closer) {
    opener.next = closer;
    closer.prev = opener;
  }
}

// Walk the resolved linked list and emit `Resolved<L>[]`. Iterative (explicit
// heap stack) rather than recursive so a pathologically deep emphasis nest —
// depth O(input length) for a crafted `*…a…*` — cannot overflow the JS call
// stack during the tree build (the seed-time crash vector). Output is
// byte-identical to a recursive DFS pre-order walk: each `wrap` pushes its
// `emphasis` node (with an already-linked-in `children` array) BEFORE the child
// frame that fills it, and each frame advances its own cursor before descending.
// Text nodes with an empty value (fully consumed delimiter runs) are dropped —
// they'd produce empty-value text leaves in the output, violating the partition
// invariant.
function toResolved<L>(head: Inline<L> | null): Resolved<L>[] {
  const root: Resolved<L>[] = [];
  // Each frame is a cursor over one sibling list, appending into `out`.
  const stack: Array<{ cur: Inline<L> | null; out: Resolved<L>[] }> = [{ cur: head, out: root }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const cur = frame.cur;
    if (cur === null) {
      stack.pop();
      continue;
    }
    frame.cur = cur.next; // advance this frame's cursor before descending
    switch (cur.kind) {
      case "text":
        if (cur.value !== "") {
          frame.out.push({ kind: "text", value: cur.value, span: cur.span });
        }
        break;
      case "node":
        frame.out.push({ kind: "leaf", leaf: cur.leaf, span: cur.span });
        break;
      case "wrap": {
        const children: Resolved<L>[] = [];
        frame.out.push({
          kind: "emphasis",
          tag: cur.tag,
          openDelim: cur.openDelim,
          closeDelim: cur.closeDelim,
          span: cur.span,
          children,
        });
        // Descend: the child frame fills `children` (already linked into out).
        stack.push({ cur: cur.childHead, out: children });
        break;
      }
    }
  }
  return root;
}
