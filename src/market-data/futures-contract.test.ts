import { expect, test } from "bun:test";
import type { FuturesContractTermsPayload } from "../api-client/futures-curve";
import {
  fitFuturesContractLines,
  futuresContractLines,
  futuresSettleText,
  futuresTickText,
  isFuturesInstrument,
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
