import { defineLanguageFacet, Language } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { Input, PartialParse, TreeFragment } from "@lezer/common";
import { NodeType, Parser, Tree } from "@lezer/common";

/**
 * Deliberately non-conformant Lezer parsers, shared by the helper contract tests
 * (./settled-state.test.ts and ./settled-view.test.ts).
 *
 * They exist because the helpers' failure arms are otherwise UNREACHABLE: a real
 * parser on a small fixture always converges, so a weakening of a throw would stay
 * silently green. Driving those arms needs a parser that fails on purpose.
 *
 * They live here rather than in one of the test files because both contract tests
 * need both stubs, and copying ~20 lines of CM-private bookkeeping into a second
 * file is exactly the duplication that let five of six `forceParse` wrappers drift
 * apart in the first place.
 */

/** Top node for the trees the stubs return; its shape is irrelevant, only length is. */
const stubTop = NodeType.define({ id: 0, name: "StubTop", top: true });

/**
 * A parser that never finishes on its own: `advance()` yields nothing until the
 * caller stops it, so the only way out of `ParseContext.work()` is the elapsed-time
 * check. Driving a helper with a 1ms budget reaches its timeout arm without a
 * five-second hang.
 *
 * Honouring `stopAt` is load-bearing rather than decoration: CM's `takeTree()` calls
 * it and then spins in `while (!advance()) {}`, which a stub that ignored it would
 * never leave.
 */
class NeverFinishingParser extends Parser {
  createParse(): PartialParse {
    let stopped: number | null = null;
    return {
      parsedPos: 0,
      get stoppedAt() {
        return stopped;
      },
      stopAt(pos: number) {
        stopped = pos;
      },
      advance: () => (stopped === null ? null : new Tree(stubTop, [], [], stopped)),
    };
  }
}

/** The length of the short tree `shortTreeLanguage()` hands back, regardless of doc size. */
export const STUB_TREE_LENGTH = 10;

/**
 * A parser that deliberately VIOLATES the Lezer contract: it claims a `parsedPos` at
 * the end of the input while returning a `Tree` that stops short of it, and its
 * `stopAt()` is a no-op. `ParseContext.work()` sets `treeLen` to
 * `parse.stoppedAt ?? state.doc.length` — never to the returned tree's length — and
 * the no-op `stopAt()` leaves `stoppedAt` null, so `treeLen` lands on the full doc
 * length while the tree is `STUB_TREE_LENGTH` units long. `ensureSyntaxTree` then
 * reports success, the helper receives the short tree, and `LanguageState.apply()`
 * republishes it as the state's snapshot.
 *
 * ⚠️ This is an INCONSISTENCY INJECTOR, not a model of CodeMirror behaviour. No
 * conformant parser reaches a helper's span guard: after a successful parse the
 * context is `isDone`, so `apply()`'s 20ms budget is never spent re-parsing. Those
 * guards are DEFENSIVE, and the tests pin only that they still fire and still report
 * the coverage numbers — not that anything in the tree today produces a short tree.
 *
 * ⚠️ The stub is coupled to CM-private `work()` bookkeeping: if upstream ever derives
 * `treeLen` from the returned tree, DELETE the describes that use it rather than
 * chase it. It now guards two callers, so delete both.
 */
class ShortTreeParser extends Parser {
  createParse(
    _input: Input,
    _fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[]
  ): PartialParse {
    return {
      parsedPos: ranges[ranges.length - 1].to,
      stoppedAt: null,
      stopAt() {},
      advance: () => new Tree(stubTop, [], [], STUB_TREE_LENGTH),
    };
  }
}

/** A Language whose parse never completes — drives the helpers' budget-exhausted arm. */
export function neverFinishingLanguage(): Extension {
  return new Language(defineLanguageFacet({}), new NeverFinishingParser());
}

/** A Language that reports success with a tree stopping at `STUB_TREE_LENGTH`. */
export function shortTreeLanguage(): Extension {
  return new Language(defineLanguageFacet({}), new ShortTreeParser());
}
