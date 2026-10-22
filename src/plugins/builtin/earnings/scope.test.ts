import { expect, test } from "bun:test";
import { member } from "../members/test-fixture";
import { getSectorCollection } from "../sectors/sector-data";
import { earningsScopeOptions, readEarningsScope, sectorSymbols } from "./scope";

test("every sector fund SECT charts is a Names choice, read from the S&P 500's holdings by its GICS sector", () => {
  const options = earningsScopeOptions({ portfolios: [], watchlists: [] });
  // A fund added to SECT without its sector would silently drop out of the filter.
  expect(options.filter((option) => option.scope.kind === "sector").map((option) => option.value))
    .toEqual(getSectorCollection("sectors").items.map((sector) => `sector:${sector.etf}`));
  // A saved choice naming a list or fund that is gone reads as the market.
  expect(readEarningsScope("watchlist:gone", options).value).toBe("all");
  const communication = readEarningsScope("sector:XLC", options).scope;
  if (communication.kind !== "sector") throw new Error("XLC is a sector fund");

  const holdings = [
    { ...member("META", 1, 0.03), sector: "Communication" },
    { ...member("googl", 1, 0.04), sector: "Communication" },
    { ...member("GOOGL", 1, 0.04), sector: "Communication" },
    { ...member("MSFT", 1, 0.06), sector: "Information Technology" },
    { ...member("CASH", 0, 0.01), symbol: null, sector: "Communication" },
  ];
  // Largest weight first, once each; a holding without a symbol (cash, futures) is not a company.
  expect(sectorSymbols(holdings, communication.sectors)).toEqual(["GOOGL", "META"]);
});
