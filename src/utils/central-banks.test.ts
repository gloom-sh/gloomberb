import { expect, test } from "bun:test";
import { FRED_CATALOG_SERIES } from "../plugins/builtin/econ/fred-catalog";
import { CENTRAL_BANKS, centralBankCiting, centralBankNamed } from "./central-banks";

test("a bank is named by any of its names, whatever the case, accents, apostrophes or a leading 'the'", () => {
  const named = (query: string) => centralBankNamed(query)?.id ?? null;
  expect(["SNB", "swiss national bank", "Norges Bank", "riksbank", "Sveriges Riksbank", "RBNZ", "ecb", "Fed", "FOMC"].map(named))
    .toEqual(["CH", "CH", "NO", "SE", "SE", "NZ", "EA", "US", "US"]);
  expect(["the People's Bank of China", "Peoples Bank of China", "Banco de Mexico", "Central Bank of the Republic of Turkiye"].map(named))
    .toEqual(["CN", "CN", "MX", "TR"]);
  // Part of a name, a venue suffix or a plain word names no bank.
  expect(["bank", "national bank", "ECB:WSE", "", "Swiss"].map(named)).toEqual([null, null, null, null, null]);
});

test("every FRED series a board row reads is in the catalog, so search and fred find it by its id", () => {
  const catalog = new Set(FRED_CATALOG_SERIES.map((series) => series.expression));
  const cited = CENTRAL_BANKS.flatMap((bank) => bank.fredSeriesIds ?? []);
  expect(cited).toEqual(["DFEDTARL", "DFEDTARU", "ECBDFR"]);
  for (const id of cited) {
    expect(catalog.has(`FRED:${id}`)).toBe(true);
    expect(centralBankCiting(id.toLowerCase())?.fredSeriesIds).toContain(id);
  }
});
