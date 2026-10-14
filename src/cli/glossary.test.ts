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
  expect(terms(lookupGlossary("discount").partial)).toEqual(["High discount margin", "Premium/discount"]);
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

test("the rebalance table's and ETF's words are found by plain names, and premium gives both meanings", () => {
  const exact = (query: string) => terms(lookupGlossary(query).exact);
  expect(["drift", "pp", "percentage points", "rebalance", "Trade Value", "target weights", "weight", "NAV", "tracking error", "discount to NAV"].map(exact))
    .toEqual([["Drift"], ["Percentage point"], ["Percentage point"], ["Trade"], ["Trade"], ["Target"], ["Weight"], ["NAV"], ["Tracking error"], ["Premium/discount"]]);
  // A perpetual's premium is over its reference price, a fund's over its NAV: `catalog explain premium` prints both.
  const premium = lookupGlossary("premium");
  expect([...terms(premium.exact), ...terms(premium.partial)]).toEqual(["Premium", "Premium/discount"]);

  // portfolio show and fn PF head the columns so; drift prints in pp (+2.3pp), never the word.
  const rebalance = "Ticker  Last  Shares  Value  Weight  Target  Drift  Trade  Trade Value  P&L\nVTI  $300.00  10  $3,000  60.0%  50.0%  +10.0pp  -2  -$500";
  expect(terms(reportGlossary("PF", rebalance))).toEqual(["Weight", "Target", "Drift", "Trade", "Percentage point"]);
  // Without targets the table has weights only; "Targets add up to" names no column.
  expect(terms(reportGlossary("PF", "Ticker  Value  Weight  P&L\nTargets add up to 90.0%; 10.0% is unallocated."))).toEqual(["Weight"]);
  expect(terms(reportGlossary("ETF", "Fund facts (fee, NAV, premium) are not available yet; try fn SEC IBIT."))).toEqual(["NAV", "Premium/discount"]);
});

test("a word that is a term whole is found before the terms that only start with it", () => {
  // `float` is the float of a stock, not the floating rate note that starts with the same letters.
  const float = lookupGlossary("float");
  expect([...terms(float.exact), ...terms(float.partial)]).toEqual(["Float", "FRN"]);
  // "Monthly-weighted" came first in the glossary, but it only starts with "weight"; Target and Drift hold it whole.
  expect(terms(lookupGlossary("weight").partial)).toEqual(["Target", "Drift", "Monthly-weighted"]);
  expect(terms(lookupGlossary("asset").partial)).toEqual(["NAV", "Fed assets"]);
  expect(["short interest", "shares short", "short ratio", "dtc", "settlement date", "crowded rising", "short squeeze", "% float"].map((query) => terms(lookupGlossary(query).exact)))
    .toEqual([["Short interest"], ["Short interest"], ["Days to cover"], ["Days to cover"], ["Settlement"], ["Crowded"], ["Squeeze"], ["Float"]]);
  // Borrow data is not offered, so it has no entry to define.
  expect(lookupGlossary("borrow fee")).toEqual({ exact: [], partial: [] });
});

test("SIV's short volume is its own term, apart from short interest", () => {
  const volume = "Date  Short %  Short volume  Total volume  Exempt volume  Status\n2026-10-13  58.79%  3.57M  6.07M  16.3k  Reported";
  expect(terms(reportGlossary("SIV", volume))).toEqual(["Short volume"]);
  expect(reportGlossary("SI", volume).map((entry) => entry.term)).not.toContain("Short volume");
});

test("a beginner's words for quotes, futures and the calendar are found by plain names, each as its own entry", () => {
  const exact = (query: string) => terms(lookupGlossary(query).exact);
  expect(["pre-market", "premarket", "PRE-MKT", "after hours", "post-market", "regular close", "close", "delayed", "ticker", "symbol", "futures contract", "futures", "forecast", "prior"].map(exact))
    .toEqual([["Pre-market"], ["Pre-market"], ["Pre-market"], ["After hours"], ["After hours"], ["Regular close"], ["Regular close"], ["Delayed"], ["Ticker"], ["Ticker"],
      ["Futures contract"], ["Futures contract"], ["Forecast"], ["Prior"]]);
  // `settle` was found only as the short-interest Settlement, a date: it is the futures settlement price now,
  // and the date stays reachable by its own words.
  expect(exact("settle")).toEqual(["Settle (futures)"]);
  expect(exact("settlement price")).toEqual(["Settle (futures)"]);
  expect(exact("settlement")).toEqual(["Settlement"]);
  expect(exact("settlement date")).toEqual(["Settlement"]);
  expect(exact("settled")).toEqual(["Settlement"]);
  expect(terms(lookupGlossary("settle").partial)).toEqual(["Settlement"]);
});

test("QQ, FUT and ECO explain the quote, futures and calendar words they print", () => {
  const quotes = [
    "Ticker  Name       Last     Change  Change %  Pre-Market",
    "AAPL    Apple Inc. $341.27  +$0.30  +0.09%    $342.68 +0.41%",
    "",
    "Source: Gloom Cloud \u00b7 Wed 14 Oct 2026 10:51 UTC \u00b7 15 min delayed \u00b7 pre-market, opens 13:30 UTC",
  ].join("\n");
  expect(terms(reportGlossary("QQ", quotes))).toEqual(["Ticker", "Pre-market", "Delayed"]);
  // An index's prior close is dated in the status line; "closed" is not "close".
  expect(terms(reportGlossary("QQ", "^GSPC  7,805.45\n\nSource: Gloom Cloud \u00b7 US trading day Tue 13 Oct 2026 close \u00b7 15 min delayed \u00b7 pre-market, opens 13:30 UTC")))
    .toEqual(["Pre-market", "Regular close", "Delayed"]);
  expect(terms(reportGlossary("QQ", "AAPL  After Hours\n\nSource: Gloom Cloud \u00b7 15 min delayed \u00b7 markets closed until Thu"))).toEqual(["After hours", "Delayed"]);

  const futures = "SESSION  SYM  CONTRACT              LAST   PREV\nOPEN     CL   WTI Crude Oil Dec 26  94.40  93.17\n\nSource: Gloom Cloud \u00b7 15 min delayed \u00b7 markets open";
  expect(terms(reportGlossary("FUT", futures))).toEqual(["Delayed", "Futures contract", "Settle (futures)"]);
  // The curve's own Settle column, and the other functions that do not print these words.
  expect(terms(reportGlossary("CTM", "Contract  Last  Settle 2026-10-13"))).toEqual(["Futures contract", "Settle (futures)"]);
  expect(reportGlossary("HP", futures)).toEqual([]);

  const calendar = "TIME (UTC)  IMP   CTY  EVENT     ACTUAL  FORECAST  PRIOR\n12:30  HIGH  US   CPI m/m   -       0.6%      0.4%";
  expect(terms(reportGlossary("ECO", calendar))).toEqual(["Actual", "Forecast", "Prior", "Impact"]);
});
