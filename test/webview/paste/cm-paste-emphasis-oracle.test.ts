// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { assertStyleParity } from "./inline-style-oracle.js";

describe("oracle self-tests", () => {
  const accept = (html: string, md: string) => () => {
    expect(() => assertStyleParity(html, md)).not.toThrow();
  };
  const reject = (html: string, md: string) => () => {
    expect(() => assertStyleParity(html, md)).toThrow(/style parity/);
  };

  it("accepts the period kept inside both runs", accept("<b>a<i>a.</i>a</b>", "**a*a*.a**"));
  it(
    "rejects a dropped bold when bold spans both neighbours",
    reject("<b>a<i>a.</i>a</b>", "**a*a***.**a**")
  );
  it(
    "accepts a drop forced by an enclosing run closing (clause ii)",
    accept("<b>a<i>a</i></b><i>(a)</i>", "**a*a***(*a)*")
  );
  it(
    "accepts a drop next to an unstyled word (clause i)",
    accept("<i>a<b>a.</b>a</i>", "*a**a**.a*")
  );
  it(
    "rejects a dropped italic when italic spans both neighbours",
    reject("<i>a<b>a.</b>a</i>", "*a**a***.*a*")
  );
  it("rejects a drop at a string edge", reject("<b>a.</b>", "**a**."));
  it("accepts a drop before an unstyled word", accept("<b>a.</b>b", "**a**.b"));
  it("trims whitespace at the HTML edge", accept("<b>a </b>", "**a**"));
  it("trims the heading separator on the Markdown side", accept("<h1>t #</h1>", "# t \\#"));
  it("collapses whitespace per text node", accept("a  <b>  b</b>", "a  **b**"));
});
