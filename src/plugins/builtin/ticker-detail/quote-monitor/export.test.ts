import { expect, setSystemTime, test } from "bun:test";
import type { Quote } from "../../../../types/financials";
import { EXCEL_CSV_BOM } from "../../../../utils/csv";
import { quoteMonitorCsv } from "./export";

test("the board's Export CSV dates each card by its own price, with its session, listing, unit and source", () => {
  setSystemTime(new Date("2026-11-06T21:35:00Z"));
  try {
    const hsi = { symbol: "^HSI", name: "HANG SENG INDEX", instrumentType: "INDEX", currency: "HKD", price: 24481.86, change: -315.12046875,
      changePercent: -1.2707964, marketState: "CLOSED", dataSource: "delayed", providerId: "gloomberb-cloud",
      lastUpdated: Date.parse("2026-11-06T08:09:00Z") } as Quote;
    const hsbc = { symbol: "0005.HK", name: "HSBC Holdings plc", currency: "HKD", price: 137.5, change: -3.6, changePercent: -2.55138199858,
      marketState: "CLOSED", dataSource: "delayed", providerId: "gloomberb-cloud", lastUpdated: Date.parse("2026-11-06T08:08:00Z") } as Quote;
    const csv = quoteMonitorCsv([
      { symbol: "^HSI", instrument: { symbol: "^HSI" }, quote: hsi },
      { symbol: "0005.HK", instrument: { symbol: "0005", exchange: "HKEX" }, quote: hsbc },
      { symbol: "NOPE", instrument: null, quote: null },
    ]);
    expect(csv.slice(EXCEL_CSV_BOM.length).split("\n")).toEqual([
      "Ticker,Name,Last,Change,Change %,Chg Basis,Session,Feed,status,symbol_or_series,currency_or_unit,interval,source,as_of",
      "^HSI,HANG SENG INDEX,24481.86,-315.12046875,-1.27,vs prev close,CLOSED,delayed,,^HSI,index points,,Gloom Cloud,2026-11-06T08:09:00.000Z",
      "0005.HK,HSBC Holdings plc,137.5,-3.6,-2.55,vs prev close,CLOSED,delayed,,0005:HKEX,HKD,,Gloom Cloud,2026-11-06T08:08:00.000Z",
      "NOPE,,,,,,,,Last: no quote,NOPE,,,,",
    ]);
  } finally {
    setSystemTime();
  }
});
