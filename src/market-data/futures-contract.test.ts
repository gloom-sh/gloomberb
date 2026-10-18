import { expect, setSystemTime, test } from "bun:test";
import type { FuturesContractTermsPayload } from "../api-client/futures-curve";
import {
  fitFuturesContractLines,
  futuresContractLines,
  futuresRollLines,
  futuresSettleText,
  futuresTickText,
  isFuturesInstrument,
  loadFuturesPriceUnit,
  resetFuturesPriceUnits,
  validateFuturesContractTerms,
} from "./futures-contract";

const gold: FuturesContractTermsPayload = {
  symbol: "GC=F", root: "GC", name: "Gold", contract: "GCZ26", contractSymbol: "GCZ26.CMX", deliveryMonth: "2026-12",
  spec: { unit: "USD / troy oz", size: "100 troy oz", pointValue: 100, tick: 0.1, tickValue: 10, settlement: "physical" },
  lastTrade: "2026-12-29", firstNotice: "2026-11-30", inDelivery: false, settlement: { price: 4216.3, date: "2026-10-09" },
};
const text = (lines: ReturnType<typeof futuresContractLines>) => lines.map((line) => `${line.label}: ${line.value}`);

test("the Contract block names the month an alias prices and leaves out lines with nothing to say", () => {
  expect(text(futuresContractLines(gold, "GC=F"))).toEqual([
    "Contract: GCZ26", "Unit: USD / troy oz", "Size: 100 troy oz", "Tick: 0.10 = $10.00", "Point Value: $100",
    "Settlement: Physical delivery", "First Notice: 2026-11-30", "Last Trade: 2026-12-29",
  ]);
  // A listed contract is the month already; a cash-settled one has no first notice.
  expect(text(futuresContractLines(gold, "gcz26.cmx"))[0]).toBe("Unit: USD / troy oz");
  const lithium = { ...gold, contract: null, firstNotice: null, lastTrade: null, settlement: null,
    spec: { ...gold.spec!, unit: "USD / kg", size: "1,000 kg", pointValue: 1000, tick: 0.01, settlement: "cash" as const } };
  expect(text(futuresContractLines(lithium, "LTH=F"))).toEqual(["Unit: USD / kg", "Size: 1,000 kg", "Tick: 0.01 = $10.00",
    "Point Value: $1,000", "Settlement: Cash settled"]);
  // Past first notice a long can be assigned delivery.
  expect(futuresContractLines({ ...gold, inDelivery: true }, "GC=F").find((line) => line.key === "firstNotice"))
    .toEqual({ key: "firstNotice", label: "First Notice", value: "2026-11-30 (passed)", warning: true });
  expect(futuresTickText({ tick: 0.015625, tickValue: 15.625 })).toBe("0.015625 = $15.625");
});

test("a short block drops the least useful lines first and keeps its order", () => {
  const lines = futuresContractLines(gold, "GC=F");
  expect(fitFuturesContractLines(lines, 4).map((line) => line.key)).toEqual(["contract", "size", "tick", "firstNotice"]);
  expect(fitFuturesContractLines(lines, 6).map((line) => line.key)).toEqual(["contract", "unit", "size", "tick", "firstNotice", "lastTrade"]);
  expect(fitFuturesContractLines(lines, Number.POSITIVE_INFINITY)).toEqual(lines);
});

test("Settle is the confirmed settlement dated by its session, -- without one, at the contract's precision with or without a quote", () => {
  const quote = { currency: "USD", instrumentType: "FUTURE" };
  expect(futuresSettleText(gold, quote)).toBe("$4,216.30 (2026-10-09)");
  expect(futuresSettleText({ settlement: null }, quote)).toBe("--");
  expect(futuresSettleText({ settlement: { price: 479.75, date: "2026-10-09" } }, { ...quote, currency: "USX" })).toBe("USX479.75 (2026-10-09)");
  // No quote yet: the tick's decimals survive and no currency is guessed.
  expect(futuresSettleText({ settlement: { price: 3.2952, date: "2026-10-09" } }, undefined)).toBe("3.2952 (2026-10-09)");
});

test("only futures symbols are looked up, and a malformed answer is refused", () => {
  expect(isFuturesInstrument("GC=F", undefined)).toBe(true);
  expect(isFuturesInstrument("CL1", "FUTURE")).toBe(true);
  expect(isFuturesInstrument("AAPL", "EQUITY")).toBe(false);
  expect(validateFuturesContractTerms(gold)).toBe(gold);
  for (const bad of [{ ...gold, settlement: { price: 4216.3, date: "10/09/2026" } }, { ...gold, spec: { ...gold.spec!, tick: 0 } },
    { ...gold, inDelivery: undefined }, { error: "Not a futures symbol with known contract terms" }]) {
    expect(() => validateFuturesContractTerms(bad as FuturesContractTermsPayload)).toThrow("invalid futures contract terms");
  }
});

test("quote's roll lines: the roll date, the front with its own price, the month left behind and the day's most active", () => {
  const nov = { contract: "NGX26", contractSymbol: "NGX26.NYM", deliveryMonth: "2026-11" };
  // NG=F on the front: its roll, and the most active month apart from it.
  const alias = { roll: { label: "1 day before last trade", date: "2026-10-27" }, front: null, nearest: null,
    mostActive: { ...nov, volume: 215_260, date: "2026-10-16" } };
  expect(text(futuresRollLines(alias))).toEqual(["Rolls: 2026-10-27, 1 day before last trade",
    "Most Active: NGX26 (Nov 26), 215,260 contracts on 2026-10-16"]);
  // A deferred month (NGF27) names the front it is not, priced from the front's own quote.
  const deferred = { roll: null, front: { ...nov, lastTrade: "2026-10-28" }, mostActive: alias.mostActive };
  const front = { price: 3.116, lastUpdated: Date.parse("2026-10-16T20:59:57Z"), currency: "USD", instrumentType: "FUTURE" };
  expect(text(futuresRollLines(deferred, front))[0]).toBe("Front: NGX26 (Nov 26) $3.116, 2026-10-16 20:59 UTC");
  expect(text(futuresRollLines(deferred, null))[0]).toBe("Front: NGX26 (Nov 26), last trade 2026-10-28");
  // CL=F the day it rolled: December now, November still trading.
  expect(text(futuresRollLines({ roll: { label: "open interest switch", date: null },
    nearest: { contract: "CLX26", contractSymbol: "CLX26.NYM", deliveryMonth: "2026-11", lastTrade: "2026-10-20" } })))
    .toEqual(["Rolls: open interest switch", "Nearest: CLX26 (Nov 26), last trade 2026-10-20"]);
  // Servers that send none of them add no lines; a malformed one is dropped and the terms stand.
  expect(futuresRollLines(gold)).toEqual([]);
  const odd = validateFuturesContractTerms({ ...gold, roll: { label: "", date: "2026-10-27" }, front: { contract: "GCZ26" } as never,
    mostActive: { ...nov, volume: -1, date: "2026-10-16" } });
  expect([odd.roll, odd.front, odd.mostActive, odd.settlement]).toEqual([null, null, null, gold.settlement]);
});

test("a futures price unit is asked once per symbol at a time, and a failed ask falls back to the catalog and is retried", async () => {
  resetFuturesPriceUnits();
  let asked = 0;
  const terms = async () => {
    asked += 1;
    return gold;
  };
  const [first, second] = await Promise.all([loadFuturesPriceUnit("GC=F", terms), loadFuturesPriceUnit("gc=f", terms)]);
  expect([first, second, asked]).toEqual(["USD / troy oz", "USD / troy oz", 1]);
  expect(await loadFuturesPriceUnit("GC=F", terms)).toBe("USD / troy oz");
  expect(asked).toBe(1);

  const failing = async (): Promise<FuturesContractTermsPayload> => {
    asked += 1;
    throw new Error("offline");
  };
  // The server has no unit for TTF; the catalog does.
  expect(await loadFuturesPriceUnit("TTF=F", async () => ({ ...gold, symbol: "TTF=F", spec: null }))).toBe("EUR / MWh");
  const now = Date.now();
  setSystemTime(now);
  try {
    expect(await loadFuturesPriceUnit("BZ=F", failing)).toBeNull();
    const brent = async () => ({ ...gold, symbol: "BZ=F", spec: { ...gold.spec!, unit: "USD / barrel" } });
    setSystemTime(now + 30_000);
    expect(await loadFuturesPriceUnit("BZ=F", brent)).toBeNull();
    setSystemTime(now + 61_000);
    expect(await loadFuturesPriceUnit("BZ=F", brent)).toBe("USD / barrel");
  } finally {
    setSystemTime();
    resetFuturesPriceUnits();
  }
});
