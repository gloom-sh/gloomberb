import { expect, test } from "bun:test";
import { GLOSSARY, lookupGlossary, reportGlossary } from "./glossary";

const terms = (entries: readonly { term: string }[]) => entries.map((entry) => entry.term);

test("a term is found by its name, abbreviation or another name, whatever its case and punctuation", () => {
  // The stop-out is the high yield; the column that compares it with the average comes with it.
  expect(lookupGlossary("Stop Out")).toEqual(lookupGlossary("stop-out"));
  expect(terms(lookupGlossary("stop-out").exact)).toEqual(["High yield"]);
  expect(terms(lookupGlossary("stop-out").partial)).toEqual(["Stop-out vs average"]);
  expect(lookupGlossary("b/c")).toEqual({ exact: [GLOSSARY.find((entry) => entry.short === "B/C")!], partial: [] });
  expect(terms(lookupGlossary("dealers").exact)).toEqual(["Dealer"]);
  expect(terms(lookupGlossary("discount").partial)).toEqual(["High discount margin"]);
  expect(lookupGlossary("carry")).toEqual({ exact: [], partial: [] });
  // Every name leads to one entry, so a lookup never has to pick between two.
  const keys = GLOSSARY.flatMap((entry) => [...new Set([entry.term, entry.short, ...entry.aliases].filter(Boolean)
    .map((name) => name!.toLowerCase().replace(/[^a-z0-9]/g, "")))]);
  expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
});

test("a report explains the terms its own function shows, read as whole labels", () => {
  const auctions = [
    "Date        Type  Term     Rate  Stop-out vs avg (bp)   B/C  Indirect  Direct  Dealer   Size  CUSIP",
    "2026-10-08  Bill  4-Week  4.048%                  1.5  2.40     57.3%   30.0%   12.7%  $110B  912797VW4",
    "2026-09-23  FRN   1-Year 10-Month  4.0bp            -  2.63     59.1%   30.0%   10.9%   $28B  91282CRD5",
    "",
    "Source: US Treasury · US trading day Thu 8 Oct 2026 · not a live feed (auction results)",
  ].join("\n");
  // A Bill row's rate is an investment rate and an FRN's a discount margin; no Note row, no high yield.
  expect(terms(reportGlossary("AUCT", `\x1b[1m${auctions}\x1b[0m`))).toEqual([
    "Bid-to-cover", "Indirect", "Direct", "Dealer", "Stop-out vs average", "Investment rate", "High discount margin",
    "Term", "CUSIP", "Bill", "FRN", "Basis point",
  ]);
  // `bp` inside `4.0bp` is a unit, not the heading GC's `Chg bp` is; another function's terms stay out.
  expect(terms(reportGlossary("GC", "Maturity  Yield  Chg bp\n10Y  5.24%  +9bp\n2026-10-08 Bill"))).toEqual(["Basis point"]);
  expect(reportGlossary("HP", auctions)).toEqual([]);
});

test("the perpetual-futures terms are found by plain names and explained from what PERP prints", () => {
  // `funding rate` once found only the bank funding rate, a different thing.
  expect(terms(lookupGlossary("funding rate").exact)).toEqual(["Funding rate"]);
  expect(terms(lookupGlossary("perp").exact)).toEqual(["Perpetual"]);
  expect(terms(lookupGlossary("perpetual futures").exact)).toEqual(["Perpetual"]);
  expect(terms(lookupGlossary("OI").exact)).toEqual(["Open interest"]);
  expect(terms(lookupGlossary("open interest").exact)).toEqual(["Open interest"]);
  expect(terms(lookupGlossary("premium").exact)).toEqual(["Premium"]);
  for (const entry of GLOSSARY.filter((candidate) => candidate.functions.includes("PERP"))) {
    expect(entry.definition).not.toMatch(/Hyperliquid|Binance|Bybit|OKX|Gloom/);
  }
  const board = "Perpetual markets\n\nMarket  Venue  Funding %/int  Premium %  OI USD  OI 24h %\nBTC  Binance  -0.00135% /8h  -0.044%  7.69B  +0.24%\n\nSource: Binance";
  expect(terms(reportGlossary("PERP", board))).toEqual(["Perpetual", "Funding rate", "Open interest", "Premium"]);
  expect(terms(reportGlossary("PERP", "Highest Funding 8h\nMarket  Venue  Funding 8h %  OI USD"))).toEqual(["Funding rate", "Open interest"]);
});
