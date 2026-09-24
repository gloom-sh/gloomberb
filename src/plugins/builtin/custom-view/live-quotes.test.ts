import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import { liveViewColumns, liveViewDecimalFloors, overlayViewRow, viewStreamTargets } from "./live-quotes";

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

  // A live price keeps cents whatever the tick, and none for a yen-only view.
  expect(liveViewDecimalFloors([row], fields)).toEqual(new Map([["price", 2], ["changePercent", 2]]));
  expect(liveViewDecimalFloors([{ ...row, currency: "JPY" }], fields).get("price")).toBe(0);
  expect(liveViewDecimalFloors([{ ...row, currency: "JPY" }, row], fields).get("price")).toBe(2);
});

test("a view streams the rows on screen fast and one screen either side in the background", () => {
  const symbols = Array.from({ length: 500 }, (_, index) => `S${index}`);
  const targets = viewStreamTargets(symbols, { start: 200, end: 230 }, 210);
  const bySymbol = new Map(targets.map((target) => [target.symbol, target]));
  // Deep in a long list: nothing from the head of the list streams.
  expect(bySymbol.has("S0")).toBe(false);
  expect(targets.filter((target) => target.visible).map((target) => target.symbol))
    .toEqual(["S210", ...symbols.slice(200, 230).filter((symbol) => symbol !== "S210")]);
  expect(bySymbol.get("S210")?.selected).toBe(true);
  expect(bySymbol.get("S170")?.visible).toBe(false);
  expect(bySymbol.get("S259")?.visible).toBe(false);
  expect(bySymbol.has("S169")).toBe(false);
  expect(bySymbol.has("S260")).toBe(false);

  // A tall pane stops at the cap, nearest the screen first; a repeated symbol streams once.
  const tall = viewStreamTargets(symbols, { start: 0, end: 80 }, 0);
  expect(tall.length).toBe(100);
  expect(tall.at(-1)?.symbol).toBe("S99");
  expect(viewStreamTargets(["aapl", "AAPL", null], { start: 0, end: 3 }, 1).map((target) => target.symbol)).toEqual(["AAPL"]);
});
