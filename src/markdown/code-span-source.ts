// Build inline-code source whose rendered body is exactly the given text.
//
// CommonMark closes a code span at the first backtick run as long as its
// opener, and strips one space from each end when the body both starts and
// ends with a space (or line ending) without being all of them. So the fence
// is one backtick longer than any run inside, and a space pads each side when
// the text borders a backtick or would lose its edge spaces to that strip.

const BACKTICK_RUN = /`+/g;

/** Length of the longest consecutive backtick run in `text` (0 when none). */
function longestBacktickRun(text: string): number {
  // A loop, not Math.max(...runs): a spread of every run overflows the call stack.
  let longest = 0;
  for (const [run] of text.matchAll(BACKTICK_RUN)) {
    longest = Math.max(longest, run.length);
  }
  return longest;
}

/** True iff CommonMark strips one character from each end of this code body. */
export function codeSpanStripsEdges(body: string): boolean {
  return /^[ \n]/.test(body) && /[ \n]$/.test(body) && /[^ \n]/.test(body);
}

/** Fence `text` as an inline-code span. Content is verbatim (never escaped).
 *  The body starts `(source.length - text.length) / 2` chars in. */
export function codeSpanSource(text: string): string {
  const longest = longestBacktickRun(text);
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 || codeSpanStripsEdges(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
