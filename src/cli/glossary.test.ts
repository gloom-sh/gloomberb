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
  expect(terms(lookupGlossary("discount").partial)).toEqual(["High discount margin", "Premium/discount", "ADR premium"]);
  // Carry is no entry of its own, but the basis trade it names is: found as a related term.
  expect(terms(lookupGlossary("carry").exact)).toEqual([]);
  expect(terms(lookupGlossary("carry").partial)).toEqual(["Futures basis"]);
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
  // A perpetual's premium is over its reference price, a fund's over its NAV, a receipt's over its home shares: `catalog explain premium` prints each.
  const premium = lookupGlossary("premium");
  expect([...terms(premium.exact), ...terms(premium.partial)]).toEqual(["Premium", "Premium/discount", "ADR premium"]);

  // portfolio show and fn PF head the columns so; drift prints in pp (+2.3pp), never the word.
  const rebalance = "Ticker  Last  Shares  Value  Weight  Target  Drift  Trade  Trade Value  P&L\nVTI  $300.00  10  $3,000  60.0%  50.0%  +10.0pp  -2  -$500";
  expect(terms(reportGlossary("PF", rebalance))).toEqual(["Weight", "Target", "Drift", "Trade", "Percentage point"]);
  // Without targets the table has weights only; "Targets add up to" names no column.
  expect(terms(reportGlossary("PF", "Ticker  Value  Weight  P&L\nTargets add up to 90.0%; 10.0% is unallocated."))).toEqual(["Weight"]);
  expect(terms(reportGlossary("ETF", "Fund facts (fee, NAV, premium) are not available yet; try fn SEC IBIT."))).toEqual(["NAV", "Premium/discount"]);
});

test("a term's related terms hold its word whole; a word no term names still finds the terms it starts", () => {
  // `float` is the float of a stock: the floating rate note only starts with the same letters, so it is not related.
  const float = lookupGlossary("float");
  expect([...terms(float.exact), ...terms(float.partial)]).toEqual(["Float"]);
  // Target and Drift hold "weight" whole; WIRP's Monthly-weighted method only starts with it.
  expect(terms(lookupGlossary("weight").partial)).toEqual(["Target", "Drift"]);
  expect(terms(lookupGlossary("settle").partial)).toEqual([]);
  // A plural holds its word whole; a search that names no term keeps the word starts after the whole words.
  expect(terms(lookupGlossary("asset").partial)).toEqual(["Fed assets", "NAV"]);
  expect(terms(lookupGlossary("vol").partial)).toEqual(["Average daily volume", "VVIX", "Short volume", "Term structure", "Contango/backwardation (VIX)", "DVOL"]);
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

test("ADR's ratio, premium and implied rate and the peso's CCL and MEP are found by the words a trader types and explained from what ADR prints", () => {
  const exact = (query: string) => terms(lookupGlossary(query).exact);
  expect(["adr", "ccl", "mep", "dolar mep", "contado con liquidacion", "implied fx", "adr discount"].map(exact))
    .toEqual([["ADR ratio"], ["Contado con liquidación"], ["Mercado electrónico de pagos"], ["Mercado electrónico de pagos"],
      ["Contado con liquidación"], ["Implied FX"], ["ADR premium"]]);
  const report = [
    "GGAL vs GGAL.BA",
    "Implied USD/ARS  1,651.28 (CCL)",
    "Spot USD/ARS     1,529.00 (official wholesale)",
    "ADR vs home      -7.4% discount (at spot)",
    "Ratio            1 ADR = 10 ordinary shares",
  ].join("\n");
  expect(terms(reportGlossary("ADR", report))).toEqual(["ADR ratio", "ADR premium", "Implied FX", "Contado con liquidación"]);
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
});

test("QQ, FUT and ECO explain the quote, futures and calendar words they print", () => {
  const quotes = [
    "Ticker  Name       Last     Change  Change %  Pre-Market",
    "AAPL    Apple Inc. $341.27  +$0.30  +0.09%    $342.68 +0.41%",
    "",
    "Source: Gloom Cloud \u00b7 Wed 14 Oct 2026 10:51 UTC \u00b7 15 min delayed \u00b7 pre-market open \u00b7 regular session opens 13:30 UTC",
  ].join("\n");
  expect(terms(reportGlossary("QQ", quotes))).toEqual(["Ticker", "Pre-market", "Delayed"]);
  // An index's prior close is dated in the status line; "closed" is not "close".
  expect(terms(reportGlossary("QQ", "^GSPC  7,805.45\n\nSource: Gloom Cloud \u00b7 US trading day Tue 13 Oct 2026 close \u00b7 15 min delayed \u00b7 pre-market open \u00b7 regular session opens 13:30 UTC")))
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

test("the futures basis, curve shape and funding words are found by plain names and explained from what CTM and PERP print", () => {
  const exact = (query: string) => terms(lookupGlossary(query).exact);
  expect(["basis", "basis trade", "cash and carry", "vs spot", "annualised basis", "annualized basis", "ann basis", "contango", "backwardation", "roll yield", "roll", "funding rate", "funding apr"].map(exact))
    .toEqual([["Futures basis"], ["Futures basis"], ["Futures basis"], ["Futures basis"], ["Annualised basis"], ["Annualised basis"], ["Annualised basis"], ["Contango"], ["Backwardation"],
      ["Roll yield"], ["Roll yield"], ["Funding rate"], ["Funding rate"]]);
  // `basis` is the futures basis, and the basis point and the annualised rate it starts a word of follow; funding rate stays one entry that also says what APR % is.
  const basis = lookupGlossary("basis");
  expect([terms(basis.exact), terms(basis.partial)]).toEqual([["Futures basis"], ["Basis point", "Annualised basis"]]);
  expect(GLOSSARY.filter((entry) => /funding rate/i.test(entry.term))).toHaveLength(1);
  expect(lookupGlossary("funding rate").exact[0]!.definition).toContain("1h rate × 24 × 365, 8h rate × 3 × 365");

  const curve = "Contract  Last  Vs Spot  Ann Basis\nBTCV26  81830.00  +0.25%  +4.3%\n\nFront spread\nLabel  State  Annualized Roll Yield\nBTCX26-BTCV26  contango  -5.71";
  expect(terms(reportGlossary("CTM", curve))).toEqual(["Futures contract", "Futures basis", "Annualised basis", "Contango", "Roll yield"]);
  expect(terms(reportGlossary("PERP", "Market  Funding %/int  Premium %  APR %\nBTC  -0.00056% /8h  -0.039%  -0.62%"))).toEqual(["Funding rate", "Premium"]);
  // The listing code quotes give a coin's composite price answers, though CTM names it in plain words.
  expect(terms(lookupGlossary("CCC").exact)).toEqual(["Crypto composite price"]);
  expect(terms(reportGlossary("CTM", "Basis against BTC-USD spot in each last trade's own minute (crypto composite price, delayed)"))).toEqual(["Crypto composite price"]);
  expect(lookupGlossary("CCC").exact[0]!.definition).not.toMatch(/CryptoCompare|Yahoo|Gloom/);
  // Another function's report shows none of them.
  expect(reportGlossary("HP", curve)).toEqual([]);
});

test("VIX explains its curve in the volatility sense, and contango and backwardation keep the futures sense too", () => {
  const report = [
    "Cash VIX tenor curve", "As of     2026-10-16", "State     Contango", "3M / 30D  1.03", "",
    "Aligned curve observations", "Index   Tenor  Level  Series", "VIX     30D    19.99  ^VIX", "",
    "Cross-asset volatility", "Index  Symbol  Level", "VVIX   ^VVIX   109.91",
  ].join("\n");
  expect(terms(reportGlossary("VIX", report))).toEqual(["Term structure", "3M/30D ratio", "Contango/backwardation (VIX)", "VVIX"]);
  expect(terms(reportGlossary("VIX", report.replace("Contango", "Backwardation")))).toContain("Contango/backwardation (VIX)");
  expect(["vvix", "vol of vol", "VIX 3M / VIX", "3M/30D", "term structure"].map((query) => terms(lookupGlossary(query).exact)))
    .toEqual([["VVIX"], ["VVIX"], ["3M/30D ratio"], ["3M/30D ratio"], ["Term structure"]]);
  const contango = lookupGlossary("contango");
  expect([terms(contango.exact), terms(contango.partial)]).toEqual([["Contango"], ["Contango/backwardation (VIX)"]]);
  // A futures curve's report keeps the futures meaning alone.
  expect(terms(reportGlossary("CTM", "Label  State\nBTCX26-BTCV26  contango"))).toEqual(["Contango"]);
});

test("EPWR explains the gas storage and EUA words its report heads columns with", () => {
  const gas = [
    "Area  Gas day     Status     % full  1D pp  TWh  Vs 1Y pp  5Y low  5Y avg  5Y high  5Y years  In 5Y range",
    "EU    2026-10-17  estimated   74.46  +0.15  843.6  -8.29   77.12   89.11    97.95         5        below",
    "",
    "Source: GIE AGSI+ · EU gas day 2026-10-17 · lag 1 day",
  ].join("\n");
  expect(terms(reportGlossary("EPWR", gas))).toEqual(["Gas day", "Estimated", "5Y range", "Percentage point"]);
  const eua = "Allowance  As of  EUR/tCO2  1D  52W low  52W high  In 1Y range\n\nLatest EUA auctions\nDate  Zone  Status  EUR/tCO2  Volume tCO2  Cover  Bidders";
  expect(terms(reportGlossary("EPWR", eua))).toEqual(["Bid-to-cover", "EUA", "1Y range"]);
});

test("the bond fund and muni words are found by plain names, and DVD explains the ones its report prints", () => {
  const exact = (query: string) => terms(lookupGlossary(query).exact);
  expect(["TEY", "tax equivalent yield", "taxable-equivalent yield", "muni treasury ratio", "muni/UST ratio", "SEC yield", "30-day SEC yield",
    "YTW", "effective duration", "average duration", "distribution yield"].map(exact)).toEqual([
    ["Tax-equivalent yield"], ["Tax-equivalent yield"], ["Tax-equivalent yield"], ["Muni/Treasury ratio"], ["Muni/Treasury ratio"],
    ["SEC yield"], ["SEC yield"], ["Yield to worst"], ["Duration"], ["Duration"], ["Distribution yield"],
  ]);
  const tey = GLOSSARY.find((entry) => entry.term === "Tax-equivalent yield")!;
  expect(tey.definition).toContain("yield / (1 - (federal rate + state rate))");
  expect(tey.definition).toContain("MUB's 4.04% is 6.83%");
  expect(GLOSSARY.find((entry) => entry.term === "Muni/Treasury ratio")!.definition).toContain("MMD or BVAL, which are licensed");
  const report = [
    "Forward distribution yield (not SEC yield)   3.27% (latest distribution annualized, as of 2026-10-01)",
    "30-day SEC yield                             4.04% (as of 2026-10-15)",
    "Yield to worst                               4.16% (as of 2026-10-15)",
    "Effective duration                           7.13 yrs (as of 2026-10-15)",
    "Tax-equivalent yield  6.83% (30-day SEC yield 4.04% as of 2026-10-15 / (1 - 40.8%))",
    "Muni/Treasury ratio   81.2% (SEC yield 4.04% / 7Y Treasury 4.98% on 2026-10-16, the tenor nearest its 7.13-year duration)",
  ].join("\n");
  expect(terms(reportGlossary("DVD", report))).toEqual([
    "SEC yield", "Yield to worst", "Distribution yield", "Duration", "Tax-equivalent yield", "Muni/Treasury ratio",
  ]);
  // A stock's DVD report prints none of them.
  expect(reportGlossary("DVD", "Trailing yield  2.24% (last 12 months of distributions)\nForward yield  2.26%")).toEqual([]);
  // One entry each for the SEC yield and the yield to worst the credit terms brought, under their names from both.
  expect(GLOSSARY.filter((entry) => ["SEC yield", "Yield to worst"].includes(entry.term))).toHaveLength(2);
  expect(["30-day yield", "worst yield", "yield-to-worst", "OAS", "effective yield"].map(exact)).toEqual([
    ["SEC yield"], ["Yield to worst"], ["Yield to worst"], ["Option-adjusted spread"], ["Effective yield"],
  ]);
  // TRACE's sale yield is the yield to worst under its Yield column; DVD's and ETF's other yields are not.
  expect(terms(reportGlossary("TRACE", "Date        Price   Yield  Size"))).toEqual(["Yield to worst"]);
  expect(reportGlossary("DVD", "Dividend Yield | KO\nTrailing yield  2.24%")).toEqual([]);
  expect(terms(reportGlossary("ETF", "Distribution Yield  3.27%\n30-Day SEC Yield  4.04% (as of 2026-10-15)"))).toEqual(["SEC yield"]);
});

test("COT's words are found by plain names and explained from the classes and columns its report heads", () => {
  const exact = (query: string) => terms(lookupGlossary(query).exact);
  expect(["COT", "commitments of traders", "noncommercial", "large speculators", "commercials", "nonreportable", "net position", "% of open interest", "1-year percentile"].map(exact))
    .toEqual([["Commitments of Traders"], ["Commitments of Traders"], ["Noncommercial"], ["Noncommercial"], ["Commercial"], ["Nonreportable"], ["Net position"],
      ["Net % of open interest"], ["Pctl 1Y"]]);
  const report = [
    "CFTC positioning", "", "COFFEE C",
    "Class            Long   Short      Net    1W Δ  Net % OI  Pctl 1Y  Pctl 3Y",
    "Noncommercial  45,600  32,064  +13,536  -2,677     +8.3%       16        6",
    "Commercial     73,156  87,408  -14,252  +3,260     -8.7%       86       95",
    "Nonreportable   7,309   6,593     +716    -583     +0.4%       41       18", "",
    "Report date  Open interest  Noncommercial net  Commercial net  Nonreportable net", "",
    "Source: CFTC · Tue 13 Oct 2026 · not a live feed (weekly report)",
  ].join("\n");
  expect(terms(reportGlossary("COT", report))).toEqual([
    "Pctl 1Y", "Open interest", "Commitments of Traders", "Noncommercial", "Commercial", "Nonreportable", "Net position", "Net % of open interest", "Weekly change", "Pctl 3Y",
  ]);
  // The disaggregated report's classes are its own.
  expect(terms(reportGlossary("COT", "Class  Net\nManaged Money  +1\nProducer/Merchant  -1\nSwap Dealers  +2\nOther Reportables  0")))
    .toEqual(["Net position", "Managed money", "Producer/merchant", "Swap dealers", "Other reportables"]);
});
