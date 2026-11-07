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
      "Ticker,Name,Last,Change,Change %,Chg Basis,Session,Feed,Chg bp,status,symbol_or_series,currency_or_unit,interval,source,as_of",
      "^HSI,HANG SENG INDEX,24481.86,-315.12,-1.27,vs prev close,CLOSED,delayed,,,^HSI,index points,,Gloom Cloud,2026-11-06T08:09:00.000Z",
      "0005:HKEX,HSBC Holdings plc,137.5,-3.6,-2.55,vs prev close,CLOSED,delayed,,,0005:HKEX,HKD,,Gloom Cloud,2026-11-06T08:08:00.000Z",
      "^TNX,CBOE Interest Rate 10 Year T Note,4.859,0.022,0.45,vs prev close,CLOSED,live,2.2,,^TNX,pct,,Interactive Brokers,2026-11-06T19:59:00.000Z",
    ]);
  } finally {
    setSystemTime();
  }
});
