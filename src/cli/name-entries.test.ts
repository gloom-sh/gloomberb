import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../types/instrument";
import { readNameEntries } from "./name-entries";
import { splitSymbolArgs } from "./symbol-args";

test("an entry with spaces is a company's name when search finds one, else the symbols it holds; a plain symbol costs no search", async () => {
  const asked: string[] = [];
  const whirlpool: InstrumentSearchResult = { providerId: "test", symbol: "WHR", name: "Whirlpool Corp", exchange: "NYSE", currency: "USD", type: "Common Stock" };
  const search = async (query: string) => {
    asked.push(query);
    return /whirlpool/i.test(query) ? [whirlpool] : [];
  };
  const entries = splitSymbolArgs(["WHR, Whirlpool Corporation , brk.b bf-b\nAAPL"]);
  expect(await readNameEntries(entries, { search })).toEqual(["WHR", "Whirlpool Corporation", "brk.b", "bf-b", "AAPL"]);
  expect(asked.filter((query) => ["WHR", "AAPL"].includes(query))).toEqual([]);
  expect(asked).toContain("brk.b bf-b");
  // Quote marks around each word of a pasted line are dropped with the rest.
  expect(await readNameEntries(splitSymbolArgs([`"AAPL" "MSFT", NVDA`]), { search })).toEqual(["AAPL", "MSFT", "NVDA"]);
});
