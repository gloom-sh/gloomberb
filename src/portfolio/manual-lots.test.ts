import { expect, test } from "bun:test";
import { createTestTicker } from "../test-support/ticker";
import { getManualPortfolioPositionPrefill } from "./manual-lots";

test("the position a save starts from totals several manual lots and leaves what cannot be totalled blank", () => {
  const lot = (shares: number, avgCost?: number, extra: Record<string, unknown> = {}) =>
    ({ portfolio: "main", shares, avgCost, currency: "USD", broker: "manual", ...extra });
  const prefill = (...positions: ReturnType<typeof lot>[]) =>
    getManualPortfolioPositionPrefill(createTestTicker("AAPL", "Apple Inc.", { portfolios: ["main"], positions }), "main");

  const single = lot(10, 150);
  expect(prefill(single).position).toBe(createTestTicker("AAPL", "Apple Inc.", { positions: [single] }).metadata.positions[0]!);
  expect(prefill(single)).toMatchObject({ lotCount: 1 });
  expect(prefill()).toEqual({ lotCount: 0, position: null });

  // Another portfolio's lots and broker lots are not part of it; fractional sums keep no float noise.
  expect(prefill(lot(0.1, 100), lot(0.2, 100), lot(7, 1, { portfolio: "other" }), lot(3, 1, { broker: "ibkr" })))
    .toMatchObject({ lotCount: 2, position: { shares: 0.3, avgCost: 100, currency: "USD" } });
  // A lot without a cost leaves the cost blank, as a single one does.
  expect(prefill(lot(10, 150), lot(5)).position).toEqual({ portfolio: "main", broker: "manual", shares: 15, currency: "USD" });
  expect(prefill(lot(10, 150, { currency: undefined }), lot(5, 170, { currency: undefined })).position)
    .toEqual({ portfolio: "main", broker: "manual", shares: 15, avgCost: 156.666666666667 });
  expect(prefill(lot(10, 150), lot(5, 170, { currency: "EUR" }))).toEqual({ lotCount: 2, position: null, currencies: ["USD", "EUR"] });
  expect(prefill(lot(10, 150), lot(5, 170, { side: "short" }))).toEqual({ lotCount: 2, position: null });
  expect(prefill(lot(10, 150), lot(-10, 160))).toEqual({ lotCount: 2, position: null });
  // Shorts total as a short, and a lot marked short reads as the negative count it is entered as.
  expect(prefill(lot(-10, 150), lot(-5, 180, { side: "short" }), lot(5, 180, { side: "short" })).position)
    .toMatchObject({ shares: -20, avgCost: 165 });
  expect(prefill(lot(4, 200, { side: "short" })).position).toEqual({ portfolio: "main", shares: -4, avgCost: 200, currency: "USD", broker: "manual" });
  // Contracts of different sizes count different things.
  expect(prefill(lot(-2, 4200, { multiplier: 100 }), lot(-3, 4210, { multiplier: 100 })).position).toMatchObject({ shares: -5, multiplier: 100 });
  expect(prefill(lot(-2, 4200, { multiplier: 100 }), lot(-3, 4210, { multiplier: 10 })).position).toBeNull();
  // A lot of no shares adds nothing and blocks nothing, whatever its side or size; lots of nothing but zero total nothing.
  expect(prefill(lot(10, 150), lot(0, 999, { side: "short", multiplier: 5 }), lot(5, 180)).position).toMatchObject({ shares: 15, avgCost: 160 });
  expect(prefill(lot(0, 150), lot(0, 160)).position).toBeNull();
});
