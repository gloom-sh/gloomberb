import { expect, test } from "bun:test";
import { futuresProductOpen } from "./futures-product-hours";

const at = (iso: string) => Date.parse(iso);
const open = (symbol: string, exchange: string | undefined, iso: string) => futuresProductOpen(symbol, exchange, at(iso));

test("grains reopen at 19:00 Central on Sunday, two hours after Globex, and pause from 07:45 to 08:30", () => {
  // Sun 22 Nov 2026, 17:30 and 18:30 CST: Globex has reopened, corn has not.
  expect(open("ZC=F", "CBOT", "2026-11-22T23:30:00Z")).toBe(false);
  expect(open("ZC=F", "CBOT", "2026-11-23T00:30:00Z")).toBe(false);
  expect(open("ZCZ26.CBT", undefined, "2026-11-23T01:00:00Z")).toBe(true);
  expect(open("ZS=F", "CBT", "2026-11-23T13:44:00Z")).toBe(true);
  expect(open("ZS=F", "CBT", "2026-11-23T13:45:00Z")).toBe(false);
  expect(open("ZS=F", "CBT", "2026-11-23T14:30:00Z")).toBe(true);
  // 13:20 Central ends the trade date; Friday evening opens nothing.
  expect(open("ZW=F", "CBT", "2026-11-23T19:20:00Z")).toBe(false);
  expect(open("ZW=F", "CBT", "2026-11-28T01:30:00Z")).toBe(false);
});

test("softs, livestock and lumber trade their own day sessions, on their own clocks across the change of clocks", () => {
  // Mon 23 Nov 2026, 10:00 New York, 09:00 Central.
  for (const [symbol, exchange] of [["KC=F", "ICE FUTURES"], ["SB=F", "NYB"], ["CC=F", "NYB"], ["OJ=F", "NYB"], ["LE=F", "CME"], ["HE=F", "CME"]]) {
    expect({ symbol, early: open(symbol!, exchange, "2026-11-23T00:30:00Z"), day: open(symbol!, exchange, "2026-11-23T15:00:00Z") })
      .toEqual({ symbol, early: false, day: true });
  }
  // Lumber opens at 09:00 Central, 15:00 UTC in winter and 14:00 UTC in summer.
  expect(open("LBR=F", "CME", "2026-11-23T14:59:00Z")).toBe(false);
  expect(open("LBR=F", "CME", "2026-11-23T15:00:00Z")).toBe(true);
  expect(open("LBR=F", "CME", "2026-07-13T14:30:00Z")).toBe(true);
  // Cotton opens at 21:00 New York the evening before, filed by its source under NY Mercantile.
  expect(open("CT=F", "NY MERCANTILE", "2026-11-23T01:30:00Z")).toBe(false);
  expect(open("CT=F", "NY MERCANTILE", "2026-11-23T02:30:00Z")).toBe(true);
});

test("a closed trade date shuts the product, an early close is the quote's to say, and Globex-day contracts are not the product clock's", () => {
  // Thanksgiving: no corn on Wednesday evening or Thursday.
  expect(open("ZC=F", "CBOT", "2026-11-26T02:00:00Z")).toBe(false);
  expect(open("LE=F", "CME", "2026-11-26T16:00:00Z")).toBe(false);
  // The Friday after closes early, at hours that vary by product.
  expect(open("LE=F", "CME", "2026-11-27T16:00:00Z")).toBeNull();
  // Outside the hours it is closed whatever the calendar holds.
  expect(open("LE=F", "CME", "2026-11-27T21:00:00Z")).toBe(false);
  for (const symbol of ["ES=F", "ZN=F", "CL=F", "GC=F", "6E=F", "VX1"]) expect(open(symbol, undefined, "2026-11-23T00:30:00Z")).toBeNull();
  // A share on a stock venue is not a contract.
  expect(open("LE", "NASDAQ", "2026-11-23T00:30:00Z")).toBeNull();
});
