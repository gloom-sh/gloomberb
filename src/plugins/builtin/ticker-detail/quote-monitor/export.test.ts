import { expect, setSystemTime, test } from "bun:test";
import type { Quote } from "../../../../types/financials";
import { EXCEL_CSV_BOM } from "../../../../utils/csv";
import { quoteMonitorCsv } from "./export";

test("the board's Export CSV is fn QQ's file: each card's listing, its move as shown, its own as-of, unit and source", () => {
  setSystemTime(new Date("2026-11-06T21:35:00Z"));
  try {
    const delayed = { marketState: "CLOSED", dataSource: "delayed", providerId: "gloomberb-cloud" } as const;
    const hsi = { ...delayed, symbol: "^HSI", name: "HANG SENG INDEX", instrumentType: "INDEX", currency: "HKD", price: 24481.86,
      change: -315.12046875, changePercent: -1.2707964, lastUpdated: Date.parse("2026-11-06T08:09:00Z") } as Quote;
    const hsbc = { ...delayed, symbol: "0005.HK", name: "HSBC Holdings plc", currency: "HKD", price: 137.5, change: -3.6,
      changePercent: -2.55138199858, lastUpdated: Date.parse("2026-11-06T08:08:00Z") } as Quote;
    // A broker's quote names the broker as its source.
    const tnx = { symbol: "^TNX", name: "CBOE Interest Rate 10 Year T Note", instrumentType: "INDEX", currency: "USD", price: 4.859,
      change: 0.022, changePercent: 0.454827372338, marketState: "CLOSED", dataSource: "live", providerId: "ibkr",
      lastUpdated: Date.parse("2026-11-06T19:59:00Z") } as Quote;
    const csv = quoteMonitorCsv([
      { symbol: "^HSI", instrument: { symbol: "^HSI" }, quote: hsi },
      { symbol: "0005.HK", instrument: { symbol: "0005", exchange: "HKEX" }, quote: hsbc },
      { symbol: "^TNX", instrument: { symbol: "^TNX" }, quote: tnx },
    ], Date.now(), (providerId) => providerId === "ibkr" ? "Interactive Brokers" : null);
    expect(csv.startsWith(EXCEL_CSV_BOM)).toBe(true);
    expect(csv.slice(EXCEL_CSV_BOM.length).split("\n")).toEqual([
      "Ticker,Name,Last,Change,Change %,Chg Basis,Session,Feed,Chg bp,status,symbol_or_series,currency_or_unit,interval,source,as_of,retrieved_at",
      "^HSI,HANG SENG INDEX,24481.86,-315.12,-1.27,vs prev close,CLOSED,delayed,,,^HSI,index points,,Gloom Cloud,2026-11-06T08:09:00.000Z,2026-11-06T21:35:00.000Z",
      "0005:HKEX,HSBC Holdings plc,137.5,-3.6,-2.55,vs prev close,CLOSED,delayed,,,0005:HKEX,HKD,,Gloom Cloud,2026-11-06T08:08:00.000Z,2026-11-06T21:35:00.000Z",
      "^TNX,CBOE Interest Rate 10 Year T Note,4.859,0.022,0.45,vs prev close,CLOSED,live,2.2,,^TNX,pct,,Interactive Brokers,2026-11-06T19:59:00.000Z,2026-11-06T21:35:00.000Z",
    ]);
  } finally {
    setSystemTime();
  }
});

test("the board's Export CSV leaves a source with no name blank, never Gloom Cloud or its id", () => {
  const pluginQuote = { symbol: "ESZ26", name: "E-mini S&P 500 Dec 2026", instrumentType: "FUTURE", currency: "USD", price: 6251.25, change: 11.25,
    changePercent: 0.18, marketState: "CLOSED", dataSource: "snapshot", providerId: "acme-feed", lastUpdated: Date.parse("2026-11-13T20:00:00Z") } as Quote;
  const csv = quoteMonitorCsv([{ symbol: "ESZ26", instrument: { symbol: "ESZ26", exchange: "CME" }, quote: pluginQuote }], Date.parse("2026-11-13T20:05:00Z"))
    .slice(EXCEL_CSV_BOM.length).split("\n");
  expect(csv[1]!.split(",").at(-3)).toBe("");
  expect(csv.join("\n")).not.toContain("acme-feed");
  expect(csv.join("\n")).not.toContain("Gloom Cloud");
});

// XYZ:NYSE's Friday close was dated at its 00:34 UTC after-hours print, which had no time of its own.
test("a close beside an after-hours print is dated at the close, the print by its own time, beside Hong Kong's close", () => {
  setSystemTime(new Date("2026-11-21T01:00:00Z"));
  try {
    const delayed = { marketState: "CLOSED", dataSource: "delayed", providerId: "gloomberb-cloud" } as const;
    const tencent = { ...delayed, symbol: "0700", name: "Tencent Holdings Ltd", currency: "HKD", listingExchangeName: "HKEX",
      price: 615, change: -5, changePercent: -0.806, changeSessionDate: "2026-11-20", lastUpdated: Date.parse("2026-11-20T08:08:00Z") } as Quote;
    const xyz = { ...delayed, symbol: "XYZ", name: "Block Inc", currency: "USD", listingExchangeName: "NYSE",
      price: 70.6, change: -0.72, changePercent: -1.01, previousClose: 71.32,
      regularClose: 69.66, regularCloseSessionDate: "2026-11-20", regularChange: -1.66, regularChangePercent: -2.33,
      changeSessionDate: "2026-11-20", lastUpdated: Date.parse("2026-11-21T00:34:00.055Z") } as Quote;
    const [header, hk, ny] = quoteMonitorCsv([
      { symbol: "0700:HKEX", instrument: { symbol: "0700", exchange: "HKEX" }, quote: tencent },
      { symbol: "XYZ:NYSE", instrument: { symbol: "XYZ", exchange: "NYSE" }, quote: xyz },
    ]).slice(EXCEL_CSV_BOM.length).split("\n").map((line) => line.split(","));
    const cell = (row: string[], column: string) => row[header!.indexOf(column)];
    expect(header!.slice(-2)).toEqual(["retrieved_at", "After Hours Updated"]);
    expect([cell(hk!, "Last"), cell(hk!, "After Hours ($)"), cell(hk!, "as_of"), cell(hk!, "After Hours Updated")])
      .toEqual(["615", "", "2026-11-20T08:08:00.000Z", ""]);
    expect([cell(ny!, "Last"), cell(ny!, "After Hours ($)"), cell(ny!, "as_of"), cell(ny!, "After Hours Updated")])
      .toEqual(["69.66", "70.6", "2026-11-20T21:00:00.000Z", "2026-11-21T00:34:00.055Z"]);
  } finally {
    setSystemTime();
  }
});
