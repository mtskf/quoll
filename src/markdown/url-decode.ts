// Pure string-level CommonMark destination normalisation. Extracted from
// lezer-url-walker.ts so the webview's click-to-open handler
// (cm/link-handlers.ts) can decode raw URL slices without importing the
// host-side Lezer walker module (parser instantiation, walker dispatch).
// The full attack-surface matrix is in test/markdown/lezer-url-walker.test.ts;
// test/markdown/url-decode.test.ts is a smoke suite to pin direct callers.
//
// (Comments preserved verbatim from lezer-url-walker.ts — they encode the
// C2 security review's rationale on decoder order, NUL substitution,
// case-insensitive named-entity lookup, and trailing-semicolon policy.)

/**
 * CommonMark destination normalization for the URL-form attack-surface
 * matrix. Pure (no mutation of input).
 *
 *   1. Strip surrounding `<` `>` if the slice is an angle-bracketed
 *      destination per CommonMark Section 6.3.
 *   2. Undo backslash escapes per CommonMark Section 2.4 (any ASCII
 *      punctuation; e.g. `\:` -> `:`).
 *   3. Decode character references per CommonMark Section 6.2 -
 *      numeric (`&#58;`), hex (`&#x3A;`), and a curated named entity
 *      set covering URL-impactful cases (scheme delimiters, control
 *      chars, basic punctuation). Full HTML entity decoding (~2000
 *      named entities) is out of scope: numeric references cover the
 *      long tail mechanically, and the matrix pins the entities we
 *      care about.
 *
 * Decoder ORDER (escape -> reference): both passes are applied; the
 * order matters only for the chained-decode contract `\&entity;` where
 * the backslash pass strips the `\` before the char-ref pass sees the
 * entity. Under SWAPPED order, the char-ref pass would still match
 * `&colon;` greedily (the leading `\` is not part of the named-entity
 * regex anchor), the input becomes `javascript\:alert(1)`, the
 * backslash pass then decodes `\:` -> `:`, and the same fail-closed
 * verdict obtains. All inputs in the test matrix reach the same verdict
 * under either order. The chosen order (escape first, then char-ref)
 * matches CommonMark's definition sequence — do not swap without
 * re-running the full security matrix, as future grammar changes may
 * introduce ordering dependencies.
 *
 * Example: `javascript\&colon;alert(1)` is decoded to
 * `javascript:alert(1)` (the `\&` becomes `&`, then `&colon;` decodes
 * to `:`) and REJECTED. A strict CommonMark reference parser would
 * leave it as `javascript&colon;alert(1)` and render an inert href;
 * that is also safe. Our decoder rejects inputs the reference parser
 * would render inert — a deliberate fail-closed overshoot per the
 * "fail-closed over CommonMark-literal" plan principle.
 */
export function decodeMarkdownDestination(raw: string): string {
  let s = raw;
  if (s.startsWith("<") && s.endsWith(">") && s.length >= 2) {
    s = s.slice(1, -1);
  }
  s = decodeBackslashEscapes(s);
  s = decodeCharacterReferences(s);
  return s;
}

function decodeBackslashEscapes(s: string): string {
  // CommonMark Section 2.4: any ASCII-punctuation character may be
  // backslash-escaped. Replace `\X` -> `X` for X in the punctuation
  // set; leave other `\X` sequences alone (CommonMark doesn't
  // recognise them).
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

// URL-impactful named entity subset. CommonMark Section 6.2 specifies
// named entities are case-sensitive, and real browsers do NOT decode
// non-canonical lowercase forms like `&tab;` / `&newline;` in `href`
// attribute contexts (they leave the literal bytes in place). We
// decode them anyway as a deliberate fail-closed policy overshoot:
// the gate decodes both `&Tab;` (canonical, which the reference parser
// would decode) and `&tab;` (non-canonical, which it would NOT decode)
// and rejects both via the C0 check. This rejects a class of inputs
// the reference parser would render inert — an intentional trade-off
// per the "fail-closed over CommonMark-literal" plan principle. Keys
// are stored lowercase and lookup is performed on `name.toLowerCase()`.
// The set covers:
//   - scheme delimiters and scheme characters (`colon`, `sol`, `plus`,
//     `period`)
//   - control characters that slip past the scheme regex undecoded but
//     are rejected by isAllowedUrl's C0 check decoded (`tab`, `newline`)
//   - punctuation that may appear in adversarial input (`amp` / `lt` /
//     `gt` / `quot` / `apos`, `space`)
// Full HTML entity decoding is out of scope (numeric references cover
// the long tail).
//
// Trailing-`;` policy is split between the two arms:
//   - Numeric references (`&#NN;` / `&#xNN;`): semicolon optional. The
//     digit-run terminates unambiguously at the first non-digit, so a
//     missing `;` does not widen the match beyond the encoded scalar.
//     Accepting `&#58` matches what some browsers do when normalizing
//     href attributes and keeps the fail-closed posture on
//     adversarially-stripped inputs.
//   - Named references: semicolon REQUIRED. The `[a-zA-Z][a-zA-Z0-9]*`
//     run is greedy and would otherwise swallow ordinary URL query
//     parameter names (e.g. `&id=1`, `&page=2`, `&utm_source=x`) that
//     are not in NAMED_ENTITIES. Without the trailing `;`, those names
//     fall through to UNDECODABLE_SUBSTITUTE → NUL, and benign
//     multi-parameter URLs are rejected by isAllowedUrl's C0 check.
//     CommonMark §6.2 also requires the `;` on named references.
// The `Lowercase<string>` constraint pins the lowercase-key invariant
// at the type level — a future contributor adding `"Tab": "\t"` or
// `"COLON": ":"` would fail the satisfies check rather than silently
// missing the `name.toLowerCase()` lookup and substituting NUL.
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  sol: "/",
  plus: "+",
  period: ".",
  tab: "\t",
  newline: "\n",
  space: " ",
} as const satisfies Record<Lowercase<string>, string>;

type NamedEntityKey = keyof typeof NAMED_ENTITIES;

// Valid Unicode code-point upper bound. String.fromCodePoint throws
// RangeError on values > 0x10FFFF (e.g. `&#x110000;`). We treat
// out-of-range references as un-decodable and substitute NUL.
//
// Surrogate range (0xD800-0xDFFF) is ALSO excluded — decoding a lone
// surrogate creates a string where the scheme regex `[a-z0-9+.-]*`
// breaks at the surrogate code unit and isAllowedUrl falls through to
// "no scheme detected -> relative path" (accept), even when the
// original input was meant to encode `javascript:`. Substituting NUL
// closes the bypass uniformly.
const SURROGATE_LOW = 0xd800;
const SURROGATE_HIGH = 0xdfff;
const MAX_CODE_POINT = 0x10ffff;

function decodableCodePoint(cp: number): boolean {
  if (!Number.isFinite(cp) || cp <= 0 || cp > MAX_CODE_POINT) {
    return false;
  }
  if (cp >= SURROGATE_LOW && cp <= SURROGATE_HIGH) {
    return false;
  }
  return true;
}

// Substitute character returned in place of an undecodable character
// reference or an unknown named entity. NUL (U+0000) is chosen because
// isAllowedUrl's C0 regex `[\u0000-\u001f\u007f]` rejects it
// unconditionally, making any URL containing an undecodable form
// fail-closed at the predicate boundary regardless of where the entity
// appeared (before/after the scheme, in the path, in the query).
//
// An earlier design returned the literal `&...;` text on undecodable
// references — that created a scheme-bypass:
// `javascript&#xD800;:alert(1)` stayed unchanged, but the scheme regex
// is head-anchored (`^([a-z][a-z0-9+.-]*):`) and FAILS to match because
// `&` is not in the char class AND the regex requires `:` directly
// after the run. schemeMatch goes null, isAllowedUrl returns true
// (relative path), fail-open. NUL substitution closes the hole.
const UNDECODABLE_SUBSTITUTE = "\u0000";

function decodeCharacterReferences(s: string): string {
  // Hex regex MUST accept both `#x` and `#X` prefixes (CommonMark
  // accepts both); the `i` flag makes the regex case-insensitive on
  // the prefix AND the hex digits AND the named-entity letter class.
  //
  // Two arms with different `;` policies (see NAMED_ENTITIES header
  // for the rationale): numeric refs accept an optional `;`, named
  // refs require it so that benign URL query parameter names are not
  // consumed as undecodable entities.
  return s.replace(
    /&(?:(#x[0-9a-f]+|#[0-9]+);?|([a-zA-Z][a-zA-Z0-9]*);)/gi,
    (_m, num: string | undefined, name: string | undefined) => {
      if (num !== undefined) {
        const second = num.charAt(1);
        if (second === "x" || second === "X") {
          const cp = Number.parseInt(num.slice(2), 16);
          return decodableCodePoint(cp) ? String.fromCodePoint(cp) : UNDECODABLE_SUBSTITUTE;
        }
        const cp = Number.parseInt(num.slice(1), 10);
        return decodableCodePoint(cp) ? String.fromCodePoint(cp) : UNDECODABLE_SUBSTITUTE;
      }
      // Named entities: lowercase lookup against a lowercase-keyed
      // table catches both CommonMark-canonical case (e.g. `&Tab;`)
      // and adversarial lowercase (e.g. `&tab;`). The "fail-closed
      // over CommonMark-literal" principle gives us license to decode
      // either form as a deliberate overshoot — browsers do NOT decode
      // lowercase `&tab;` in href contexts, but the gate rejects both
      // forms uniformly (see NAMED_ENTITIES header for the rationale).
      // An UNKNOWN named entity is treated as undecodable
      // and substituted (same fail-closed reasoning as numeric
      // undecodables): leaving `&unknownentity;` literal would let an
      // attacker hide scheme chars (`javascript&unknownentity;:alert(1)`
      // breaks the head-anchored scheme regex and accepts as relative).
      // The `Object.hasOwn` guard is what keeps prototype member names in
      // that unknown set: NAMED_ENTITIES is a plain object literal, so a
      // bare index would resolve `&constructor;` (and any other
      // Object.prototype member name surviving the `.toLowerCase()` fold)
      // to the inherited native function — coercing its source string into
      // the URL and bypassing the NUL substitute. Mirrors the own-property
      // guard in cell-render.ts's decodeAltEntities.
      const key = (name as string).toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key)
        ? NAMED_ENTITIES[key as NamedEntityKey]
        : UNDECODABLE_SUBSTITUTE;
    }
  );
}
