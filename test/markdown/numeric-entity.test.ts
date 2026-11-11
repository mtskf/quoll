import { describe, expect, it } from "vitest";
import { decodeNumericEntity } from "../../src/markdown/numeric-entity.js";

describe("numeric entities", () => {
  it("decodes decimal and hexadecimal numeric references", () => {
    for (const [raw, value] of [
      ["&#97;", "a"],
      ["&#x61;", "a"],
      ["&#X000061;", "a"],
      ["&#8288;", "\u2060"],
      ["&#x1F600;", "😀"],
    ]) {
      expect(decodeNumericEntity(raw)).toBe(value);
    }
  });
  it("requires a complete numeric reference within CommonMark digit limits", () => {
    for (const raw of [
      "&#1",
      "&#-1;",
      "&#;",
      "&#x;",
      "&#1;x",
      "&amp;",
      "&#12345678;",
      "&#x1234567;",
    ]) {
      expect(decodeNumericEntity(raw)).toBeNull();
    }
    expect(decodeNumericEntity("&#0000001;")).toBe("\u0001");
    expect(decodeNumericEntity("&#x000001;")).toBe("\u0001");
  });
  it("replaces zero surrogate and out-of-range numeric values without throwing", () => {
    for (const raw of ["&#0;", "&#xD800;", "&#xDFFF;", "&#x110000;"]) {
      expect(decodeNumericEntity(raw)).toBe("�");
    }
    expect(decodeNumericEntity("&#xD7FF;")).toBe("\uD7FF");
    expect(decodeNumericEntity("&#xE000;")).toBe("\uE000");
    expect(decodeNumericEntity("&#x10FFFF;")).toBe(String.fromCodePoint(0x10ffff));
  });
  it("decodes once without interpreting the result as markup", () => {
    expect(decodeNumericEntity("&#38;")).toBe("&");
    expect(decodeNumericEntity("&#60;")).toBe("<");
  });
});
