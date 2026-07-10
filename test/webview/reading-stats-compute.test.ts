// test/webview/reading-stats-compute.test.ts
import { describe, expect, it } from "vitest";
import {
  computeReadingStats,
  WORDS_PER_MINUTE,
} from "../../src/webview/cm/reading-stats/compute.js";

describe("computeReadingStats — word/char counting", () => {
  it("counts plain English words and non-whitespace characters", () => {
    const s = computeReadingStats("Hello there, world");
    expect(s.words).toBe(3);
    // "Hellothere,world" = 16 non-space code points
    expect(s.characters).toBe(16);
  });

  it("collapses runs of whitespace and ignores leading/trailing space", () => {
    expect(computeReadingStats("  one   two\n\nthree  ").words).toBe(3);
  });

  it("returns zeros for empty / whitespace-only input", () => {
    expect(computeReadingStats("")).toEqual({ words: 0, characters: 0, readingTimeMinutes: 0 });
    expect(computeReadingStats("   \n\t ")).toEqual({
      words: 0,
      characters: 0,
      readingTimeMinutes: 0,
    });
  });

  it("excludes a leading YAML frontmatter block from counts", () => {
    const doc = "---\ntitle: My Post\ntags: [a, b]\n---\nhello world\n";
    const s = computeReadingStats(doc);
    expect(s.words).toBe(2); // only "hello world"
    expect(s.characters).toBe([..."helloworld"].length);
  });

  it("does NOT strip a `---` that is not a file-leading frontmatter fence", () => {
    // A thematic break mid-document is not frontmatter, so the content on BOTH
    // sides is still counted. Tokens: intro, para, ---, after, break = 5.
    // (The bare `---` counts as one whitespace-delimited token — acceptable;
    // the point of this case is that mid-doc `---` is NOT stripped as a block.)
    const s = computeReadingStats("intro para\n\n---\n\nafter break");
    expect(s.words).toBe(5);
  });

  it("excludes fenced code blocks from counts", () => {
    const doc = "before code\n\n```js\nconst x = 1; // many tokens here\n```\n\nafter code";
    const s = computeReadingStats(doc);
    expect(s.words).toBe(4); // before code after code
  });

  it("excludes tilde-fenced code blocks too", () => {
    const doc = "alpha\n\n~~~\nignored ignored ignored\n~~~\n\nbeta";
    expect(computeReadingStats(doc).words).toBe(2); // alpha beta
  });

  it("counts each CJK character as one word (character-based, not morpheme)", () => {
    // 5 kanji + 1 hiragana = 6 CJK code points
    const s = computeReadingStats("今日は良い天気");
    expect(s.words).toBe(7); // 今 日 は 良 い 天 気
    expect(s.characters).toBe(7);
  });

  it("mixes CJK characters and Latin words additively", () => {
    // "日本語" (3 CJK) + "and English" (2 Latin words) = 5
    expect(computeReadingStats("日本語 and English").words).toBe(5);
  });

  it("estimates reading time at WORDS_PER_MINUTE, min 1 for any content", () => {
    expect(WORDS_PER_MINUTE).toBe(200);
    expect(computeReadingStats("one two three").readingTimeMinutes).toBe(1);
    const long = Array.from({ length: 450 }, () => "word").join(" ");
    expect(computeReadingStats(long).readingTimeMinutes).toBe(3); // ceil(450/200)=3
    expect(computeReadingStats("").readingTimeMinutes).toBe(0);
  });
});
