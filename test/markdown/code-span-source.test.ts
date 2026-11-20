import { expect, it } from "vitest";
import { codeSpanSource } from "../../src/markdown/code-span-source.js";

it("fences a text with more backtick runs than a call can take as arguments", () => {
  // Spreading every run into Math.max overflows the call stack at this count.
  const text = "a`".repeat(250_000);
  expect(codeSpanSource(text)).toBe(`\`\` ${text} \`\``);
});

it("fences past the longest run, wherever it sits", () => {
  expect(codeSpanSource("a`b```c``")).toBe("```` a`b```c`` ````");
});
