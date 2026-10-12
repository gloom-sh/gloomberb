import { expect, test } from "bun:test";
import { findCatalogSeries } from "../../../cli/series-search";
import { CENTRAL_BANK_SERIES } from "./series";

test("the catalog names who publishes each policy rate: FRED for the Fed and the ECB, the BIS for the rest", () => {
  const matches = findCatalogSeries([{ series: CENTRAL_BANK_SERIES }], "policy rate");
  expect(matches).toHaveLength(20);
  const publisher = (id: string) => matches.find((match) => match.id === id)?.publisher;
  expect([publisher("policy-rate:us"), publisher("policy-rate:ea")]).toEqual(["FRED", "FRED"]);
  expect(matches.filter((match) => !match.id.endsWith(":us") && !match.id.endsWith(":ea")).map((match) => match.publisher))
    .toEqual(Array(18).fill("BIS"));
  // The publisher is searchable, as it is for the FRED series.
  expect(findCatalogSeries([{ series: CENTRAL_BANK_SERIES }], "bis")).toHaveLength(18);
});
