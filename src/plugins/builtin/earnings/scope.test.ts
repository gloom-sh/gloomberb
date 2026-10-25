import { expect, test } from "bun:test";
import { member } from "../members/test-fixture";
import { fundSymbols } from "./scope";

test("fund symbols exclude unlisted holdings and duplicates without changing the shared holdings order", () => {
  const holdings = [
    { ...member("msft", 1, 0.03), sector: null },
    member("NVDA", 1, 0.08),
    member(" MSFT ", 1, 0.02),
    { ...member("CASH", 0, 0.01), symbol: null },
    member("  ", 0, 0.01),
  ];
  const original = [...holdings];
  expect(fundSymbols(holdings)).toEqual(["NVDA", "MSFT"]);
  expect(holdings).toEqual(original);
});
