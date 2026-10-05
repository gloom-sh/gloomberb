import { describe, expect, test } from "bun:test";
import { decodeHtmlEntities } from "./html-entities";

describe("decodeHtmlEntities", () => {
  test("decodes common tweet and filing HTML entities", () => {
    expect(decodeHtmlEntities("demand/supply &amp; unit economics &#36;ASML")).toBe("demand/supply & unit economics $ASML");
    expect(decodeHtmlEntities("the Company&rsquo;s &ldquo;policy&rdquo; &mdash; ASC 946 &sect; 2")).toBe("the Company\u2019s \u201Cpolicy\u201D \u2014 ASC 946 \u00A7 2");
  });
});
