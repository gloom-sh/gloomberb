import { expect, setSystemTime, test } from "bun:test";
import type { FuturesContractTermsPayload } from "../api-client/futures-curve";
import {
  fitFuturesContractLines,
  futuresChangeBasis,
  futuresContractLines,
  futuresRollLines,
  futuresSettleText,
  futuresTickText,
  isFuturesInstrument,
  loadFuturesPriceUnit,
  minorUnitPricePer,
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
  expect(futuresSettleText({ settlement: { price: 479.75, date: "2026-10-09" } }, { ...quote, currency: "USX" })).toBe("479.75¢ (2026-10-09)");
  // No quote yet: the tick's decimals survive and no currency is guessed.
  expect(futuresSettleText({ settlement: { price: 3.2952, date: "2026-10-09" } }, undefined)).toBe("3.2952 (2026-10-09)");
  // Beside a move from a later session than the settlement's it waits for that session's, never an older one in its place.
  expect(futuresSettleText(gold, quote, "2026-10-12")).toBe("-- (2026-10-12 not confirmed yet)");
  expect(futuresSettleText(gold, quote, "2026-10-09")).toBe("$4,216.30 (2026-10-09)");
  // A settlement of the move's own session, newer than the close it is from, is the latest and stays.
  expect(futuresSettleText(gold, quote, "2026-10-08")).toBe("$4,216.30 (2026-10-09)");
  expect(futuresSettleText({ settlement: null }, quote, "2026-10-12")).toBe("--");
});

test("a price in cents says what it is per, and a dollar price reads as before", () => {
  const coffee = { spec: { ...gold.spec!, unit: "US cents / lb" } };
  expect(minorUnitPricePer(coffee, "USX")).toBe("/lb");
  expect(minorUnitPricePer({ spec: { ...gold.spec!, unit: "US cents / bushel" } }, "USX")).toBe("/bu");
  expect(minorUnitPricePer(gold, "USD")).toBe("");
  // Terms in another currency than the quote's, or none, add nothing rather than a wrong unit.
  expect(minorUnitPricePer(gold, "USX")).toBe("");
  expect(minorUnitPricePer(null, "USX")).toBe("");
});

test("a futures move names what it is measured from, as far as the settlement in the terms shows", () => {
  const tick = { tick: 0.25 };
  const basis = (settlement: { price: number; date: string } | null, price: number, change: number, sessionDate = "2026-10-19") =>
    futuresChangeBasis({ settlement, spec: tick }, { price, change, sessionDate }, "CME");
  // Monday's move from Friday's settlement, which the terms still carry.
  expect(basis({ price: 5645, date: "2026-10-16" }, 5626, -19)).toEqual({ kind: "settle", session: "2026-10-16" });
  // Once Monday settles the terms no longer hold Friday's settlement: Friday's close, unchecked.
  expect(basis({ price: 5630, date: "2026-10-19" }, 5626, -19)).toEqual({ kind: "close", session: "2026-10-16" });
  // A move from Monday's own settlement is from Monday, whatever the date it carries.
  expect(basis({ price: 5630, date: "2026-10-19" }, 5640, 10)).toEqual({ kind: "settle", session: "2026-10-19" });
  // From Friday's last trade, not its settlement.
  expect(basis({ price: 5645, date: "2026-10-16" }, 5626, -22)).toEqual({ kind: "last trade", session: "2026-10-16" });
  // Friday has not settled yet: Friday's close, without claiming a settlement.
  expect(basis({ price: 5600, date: "2026-10-15" }, 5626, -22)).toEqual({ kind: "close", session: "2026-10-16" });
  expect(basis(null, 5626, -22, "2026-10-21")).toEqual({ kind: "close", session: "2026-10-20" });
  // A source that rounds the move stays within half a tick of the settlement; a tick away is another price.
  expect(basis({ price: 5645.25, date: "2026-10-16" }, 5626.25, -19.1)?.kind).toBe("settle");
  expect(basis({ price: 5645.25, date: "2026-10-16" }, 5626.25, -18.75)?.kind).toBe("last trade");
  // Without a tick, half a basis point of the price: 311.9 - 6.3 is 305.59999999999997.
  expect(futuresChangeBasis({ settlement: { price: 305.6, date: "2026-10-16" } }, { price: 311.9, change: 6.3, sessionDate: "2026-10-19" }, "CBT")?.kind)
    .toBe("settle");
  expect(basis({ price: 5645, date: "2026-10-16" }, 5626, -19, "")).toBeNull();
  expect(futuresChangeBasis({ settlement: null }, { price: 5626, change: null, sessionDate: "2026-10-19" }, "CME")).toBeNull();
});

test("on a Saturday the move is Friday's, from Thursday", () => {
  const thursday = { price: 312.4, date: "2026-10-15" };
  const friday = { price: 314.95, date: "2026-10-16" };
  const move = { price: 314.95, change: 2.55 };
  const coffee = (settlement: { price: number; date: string }, sessionDate: string) =>
    futuresChangeBasis({ settlement, spec: { tick: 0.05 } }, { ...move, sessionDate }, "NYB");
  // Friday not settled yet, or a source that dates the quote by the Saturday it was read: still Thursday's settlement.
  expect(coffee(thursday, "2026-10-16")).toEqual({ kind: "settle", session: "2026-10-15" });
  expect(coffee(thursday, "2026-10-17")).toEqual({ kind: "settle", session: "2026-10-15" });
  // Friday settled: the terms hold Friday's settlement only, so Thursday's reference is its close.
  expect(coffee(friday, "2026-10-17")).toEqual({ kind: "close", session: "2026-10-15" });
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
