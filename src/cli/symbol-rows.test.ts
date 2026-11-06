import { expect, test } from "bun:test";
import { summarizeSymbolRows, type SymbolRow } from "./symbol-rows";

const added = (input: string, symbol: string, exchange: string): SymbolRow => ({
  input, status: "added", listing: `${symbol}:${exchange}`, symbol, exchange, name: symbol, message: null, notes: null, hint: null,
});

test("a list add names the rows that landed off the list's main venues, the US exchanges as one market and a pair as none", () => {
  const book = [
    ...Array.from({ length: 6 }, (_, index) => added(`L${index}.L`, `L${index}`, "LSE")),
    ...Array.from({ length: 5 }, (_, index) => added(`${7200 + index}.T`, String(7200 + index), "JPX")),
    added("BP", "BP", "NYSE"), added("NTT", "NTT", "WSE"), added("GBPUSD=X", "GBPUSD=X", "CCY"),
  ];
  expect(summarizeSymbolRows(book, "add", 0)).toBe("14 added; 2 landed outside the list's main venues (LSE, JPX): BP as BP:NYSE, NTT as NTT:WSE.");
  // A US list on NYSE and NASDAQ is on one market.
  const us = Array.from({ length: 10 }, (_, index) => added(`U${index}`, `U${index}`, index % 2 ? "NYSE" : "NASDAQ"));
  expect(summarizeSymbolRows(us, "add", 0)).toBe("10 added.");
});
