import { expect, it } from "vitest";

import {
  type Resolved,
  resolveInline,
  type Segment,
} from "../../src/webview/cm/inline/inline-emphasis.js";

// Build segments with running spans so assertions can check offsets.
type S = Segment<string>;
const sp = (from: number, to: number) => ({ from, to });

it("returns [] for no segments", () => {
  expect(resolveInline<string>([])).toEqual([]);
});

it("passes text segments through unchanged (no merging in the engine)", () => {
  // The engine no longer merges adjacent text — that's the renderer's job.
  const out = resolveInline<string>([
    { kind: "text", value: "hel", span: sp(0, 3) },
    { kind: "text", value: "lo", span: sp(3, 5) },
  ]);
  expect(out).toEqual([
    { kind: "text", value: "hel", span: sp(0, 3) },
    { kind: "text", value: "lo", span: sp(3, 5) },
  ]);
});

it("passes text and a leaf through, wrapped by emphasis", () => {
  // *X*  where X is an opaque leaf occupying [1,2)
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 1), canOpen: true, canClose: false },
    { kind: "leaf", leaf: "X", span: sp(1, 2) },
    { kind: "delim", ch: "*", span: sp(2, 3), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  expect(out).toHaveLength(1);
  const em = out[0] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(em.kind).toBe("emphasis");
  expect(em.tag).toBe("em");
  expect(em.openDelim).toEqual(sp(0, 1));
  expect(em.closeDelim).toEqual(sp(2, 3));
  expect(em.span).toEqual(sp(0, 3));
  expect(em.children).toEqual([{ kind: "leaf", leaf: "X", span: sp(1, 2) }]);
});

it("wraps a single `*` pair as em", () => {
  // *em*  → [0,1) text [1,3) [3,4)
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 1), canOpen: true, canClose: false },
    { kind: "text", value: "em", span: sp(1, 3) },
    { kind: "delim", ch: "*", span: sp(3, 4), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  expect(out).toHaveLength(1);
  const em = out[0] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(em.kind).toBe("emphasis");
  expect(em.tag).toBe("em");
  expect(em.openDelim).toEqual(sp(0, 1));
  expect(em.closeDelim).toEqual(sp(3, 4));
  expect(em.span).toEqual(sp(0, 4));
  expect(em.children).toEqual([{ kind: "text", value: "em", span: sp(1, 3) }]);
});

it("wraps a `**` pair as strong", () => {
  // **b**  → [0,2) text [2,3) [3,5)
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 2), canOpen: true, canClose: false },
    { kind: "text", value: "b", span: sp(2, 3) },
    { kind: "delim", ch: "*", span: sp(3, 5), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  expect(out).toHaveLength(1);
  const strong = out[0] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(strong.kind).toBe("emphasis");
  expect(strong.tag).toBe("strong");
  expect(strong.openDelim).toEqual(sp(0, 2));
  expect(strong.closeDelim).toEqual(sp(3, 5));
  expect(strong.span).toEqual(sp(0, 5));
  expect(strong.children).toEqual([{ kind: "text", value: "b", span: sp(2, 3) }]);
});

it("splits *** into nested em>strong with correct delimiter spans", () => {
  // ***t***  delims [0,3) and [4,7), text [3,4)
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 3), canOpen: true, canClose: false },
    { kind: "text", value: "t", span: sp(3, 4) },
    { kind: "delim", ch: "*", span: sp(4, 7), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  // Ported algorithm order (inline-emphasis.ts): the `strong` forms FIRST,
  // consuming the TWO inner delimiters of each run; the `em` then consumes the
  // ONE remaining outer delimiter of each run. So `em` wraps the OUTERMOST `*`
  // of each run and `strong` the inner two. The spans MUST be source-ordered to
  // satisfy the partition invariant (Codex plan review Conf 99):
  //   open run [0,3): strong=[1,3), em=[0,1)   close run [4,7): strong=[4,6), em=[6,7)
  // Depth-first leaves: em.open[0,1) strong.open[1,3) text[3,4) strong.close[4,6) em.close[6,7).
  expect(out).toHaveLength(1);
  const em = out[0] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(em.tag).toBe("em");
  expect(em.openDelim).toEqual(sp(0, 1));
  expect(em.closeDelim).toEqual(sp(6, 7));
  expect(em.span).toEqual(sp(0, 7));
  const strong = em.children[0] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(strong.tag).toBe("strong");
  expect(strong.openDelim).toEqual(sp(1, 3));
  expect(strong.closeDelim).toEqual(sp(4, 6));
  expect(strong.span).toEqual(sp(1, 6));
  expect(strong.children).toEqual([{ kind: "text", value: "t", span: sp(3, 4) }]);
});

it("applies the rule of 3 so `*a**b*` keeps the inner `**` literal", () => {
  // *a**b*  → *(open,1,[0,1)) a(text,[1,2)) **(both,2,[2,4)) b(text,[4,5)) *(close,1,[5,6))
  // For the outer pair: opener=*(open1) canOpen=true canClose=false, closer=*(close1) canOpen=false canClose=true.
  // oddMatch = (closer.canOpen || opener.canClose) && ... = (false || false) && ... = false → no oddMatch → normal match.
  // The *open matches *close → <em>a**b</em> (the ** is left literal inside em)
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 1), canOpen: true, canClose: false },
    { kind: "text", value: "a", span: sp(1, 2) },
    { kind: "delim", ch: "*", span: sp(2, 4), canOpen: true, canClose: true },
    { kind: "text", value: "b", span: sp(4, 5) },
    { kind: "delim", ch: "*", span: sp(5, 6), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  expect(out).toHaveLength(1);
  const em = out[0] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(em.kind).toBe("emphasis");
  expect(em.tag).toBe("em");
  expect(em.openDelim).toEqual(sp(0, 1));
  expect(em.closeDelim).toEqual(sp(5, 6));
  // Inner ** is unmatched → literal text "**" with span [2,4)
  expect(em.children).toEqual([
    { kind: "text", value: "a", span: sp(1, 2) },
    { kind: "text", value: "**", span: sp(2, 4) },
    { kind: "text", value: "b", span: sp(4, 5) },
  ]);
});

it("leaves a leftover opener delimiter as literal text (`**a*` shape)", () => {
  // **a*  → **(open,2,[0,2)) a(text,[2,3)) *(close,1,[3,4))
  // closer len=1, opener len=2 → useDelims=1 → em with openDelim=[1,2), closeDelim=[3,4)
  // Remaining opener text: [0,1) → value="*"
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 2), canOpen: true, canClose: false },
    { kind: "text", value: "a", span: sp(2, 3) },
    { kind: "delim", ch: "*", span: sp(3, 4), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({ kind: "text", value: "*", span: sp(0, 1) });
  const em = out[1] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(em.kind).toBe("emphasis");
  expect(em.tag).toBe("em");
  expect(em.openDelim).toEqual(sp(1, 2));
  expect(em.closeDelim).toEqual(sp(3, 4));
  expect(em.children).toEqual([{ kind: "text", value: "a", span: sp(2, 3) }]);
});

it("separates openers_bottom by canOpen so `**a*a*a*` nests (6-state regression)", () => {
  // **a*a*a*  → **(open,2,[0,2)) a(text,[2,3)) *(both,1,[3,4)) a(text,[4,5))
  //             *(both,1,[5,6)) a(text,[6,7)) *(close,1,[7,8))
  // A 3-state openers_bottom regresses this to `**a<em>a</em>a*`.
  // Correct: *<em>a<em>a</em>a</em>
  // The ** opener (len=2) matches the last * closer (len=1) → useDelims=1 → em
  //   openDelim=[1,2), closeDelim=[7,8)
  //   remaining opener text: [0,1) → "*"
  // Inner: *(both,[3,4)) matches *(both,[5,6)) → useDelims=1 → em
  //   openDelim=[3,4), closeDelim=[5,6)
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 2), canOpen: true, canClose: false },
    { kind: "text", value: "a", span: sp(2, 3) },
    { kind: "delim", ch: "*", span: sp(3, 4), canOpen: true, canClose: true },
    { kind: "text", value: "a", span: sp(4, 5) },
    { kind: "delim", ch: "*", span: sp(5, 6), canOpen: true, canClose: true },
    { kind: "text", value: "a", span: sp(6, 7) },
    { kind: "delim", ch: "*", span: sp(7, 8), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  // Expected: "*" + <em>a<em>a</em>a</em>
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({ kind: "text", value: "*", span: sp(0, 1) });
  const outerEm = out[1] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(outerEm.kind).toBe("emphasis");
  expect(outerEm.tag).toBe("em");
  expect(outerEm.openDelim).toEqual(sp(1, 2));
  expect(outerEm.closeDelim).toEqual(sp(7, 8));
  // outerEm.children: a, <em>a</em>, a
  expect(outerEm.children[0]).toEqual({ kind: "text", value: "a", span: sp(2, 3) });
  const innerEm = outerEm.children[1] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(innerEm.kind).toBe("emphasis");
  expect(innerEm.tag).toBe("em");
  expect(innerEm.openDelim).toEqual(sp(3, 4));
  expect(innerEm.closeDelim).toEqual(sp(5, 6));
  expect(innerEm.children).toEqual([{ kind: "text", value: "a", span: sp(4, 5) }]);
  expect(outerEm.children[2]).toEqual({ kind: "text", value: "a", span: sp(6, 7) });
});

it("nests `*` inside `**` (`**a *b* c**` shape)", () => {
  // **a *b* c**  → **(open,2,[0,2)) a (text,[2,4)) *(both,1,[4,5)) b(text,[5,6))
  //               *(both,1,[6,7)) c(text,[7,9)) **(close,2,[9,11))
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 2), canOpen: true, canClose: false },
    { kind: "text", value: "a ", span: sp(2, 4) },
    { kind: "delim", ch: "*", span: sp(4, 5), canOpen: true, canClose: true },
    { kind: "text", value: "b", span: sp(5, 6) },
    { kind: "delim", ch: "*", span: sp(6, 7), canOpen: true, canClose: true },
    { kind: "text", value: " c", span: sp(7, 9) },
    { kind: "delim", ch: "*", span: sp(9, 11), canOpen: false, canClose: true },
  ];
  const out = resolveInline(segs);
  expect(out).toHaveLength(1);
  const strong = out[0] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(strong.kind).toBe("emphasis");
  expect(strong.tag).toBe("strong");
  expect(strong.openDelim).toEqual(sp(0, 2));
  expect(strong.closeDelim).toEqual(sp(9, 11));
  expect(strong.span).toEqual(sp(0, 11));
  // children: "a ", <em>b</em>, " c"
  expect(strong.children[0]).toEqual({ kind: "text", value: "a ", span: sp(2, 4) });
  const innerEm = strong.children[1] as Extract<Resolved<string>, { kind: "emphasis" }>;
  expect(innerEm.kind).toBe("emphasis");
  expect(innerEm.tag).toBe("em");
  expect(innerEm.openDelim).toEqual(sp(4, 5));
  expect(innerEm.closeDelim).toEqual(sp(6, 7));
  expect(innerEm.children).toEqual([{ kind: "text", value: "b", span: sp(5, 6) }]);
  expect(strong.children[2]).toEqual({ kind: "text", value: " c", span: sp(7, 9) });
});

it("leaves unmatched delimiters as text leaves", () => {
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 2), canOpen: true, canClose: false },
    { kind: "text", value: "x", span: sp(2, 3) },
  ];
  expect(resolveInline(segs)).toEqual([
    { kind: "text", value: "**", span: sp(0, 2) },
    { kind: "text", value: "x", span: sp(2, 3) },
  ]);
});

it("renders unmatched `**unclosed` as literal text nodes", () => {
  // **unclosed → **(open,2,[0,2)) unclosed(text,[2,10))
  const segs: S[] = [
    { kind: "delim", ch: "*", span: sp(0, 2), canOpen: true, canClose: false },
    { kind: "text", value: "unclosed", span: sp(2, 10) },
  ];
  const out = resolveInline(segs);
  expect(out).toEqual([
    { kind: "text", value: "**", span: sp(0, 2) },
    { kind: "text", value: "unclosed", span: sp(2, 10) },
  ]);
});
