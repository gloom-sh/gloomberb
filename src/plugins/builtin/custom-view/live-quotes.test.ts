import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { liveViewColumns, overlayViewRow } from "./live-quotes";

const quote: Quote = { symbol: "NVDA", price: 181.5, change: 3, changePercent: 1.68, volume: 12_000_000, currency: "USD", lastUpdated: 1 };

test("only a listing's own last price, day change and volume stream into a view", () => {
  const fields = liveViewColumns([
    { key: "symbol", header: "Symbol" },
    { key: "price", header: "Last" },
    { key: "changePercent", header: "Change %" },
    { key: "volume", header: "Volume" },
    { key: "marketCap", header: "Market cap" },
  ]);
  expect([...fields]).toEqual([["price", "price"], ["changePercent", "changePercent"], ["volume", "volume"]]);
  // Same key, different meaning: an entry price, a bond price, a change in basis points.
  expect(liveViewColumns([
    { key: "price", header: "Entry" },
    { key: "price", header: "Price" },
    { key: "change", header: "Change" },
  ]).size).toBe(0);

  const row = { symbol: "NVDA", price: 170, changePercent: -1, volume: 1, currency: "USD", name: "Nvidia" };
  expect(overlayViewRow(row, quote, fields)).toEqual({ ...row, price: 181.5, changePercent: 1.68, volume: 12_000_000 });
  expect(overlayViewRow(row, { ...quote, currency: "EUR" }, fields)).toBe(row);
  expect(overlayViewRow(row, { ...quote, stale: true }, fields)).toBe(row);
});
