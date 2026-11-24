import { expect, test } from "bun:test";
import { taiwanListing } from "./taiwan";

test("Taiwan's two trading venues keep their own balances, including vendor suffixes", () => {
  expect(taiwanListing("2454:TPE")).toEqual({symbol:"2454", exchange:"TWSE"});
  expect(taiwanListing("6488.TWO")).toEqual({symbol:"6488", exchange:"TPEX"});
  expect(taiwanListing("00400A", "TWSE")).toEqual({symbol:"00400A", exchange:"TWSE"});
  for (const key of ["6488.TWO:TWSE","2454.TW:JPX","2454","TSM:NYSE"]) expect(taiwanListing(key)).toBeNull();
});
