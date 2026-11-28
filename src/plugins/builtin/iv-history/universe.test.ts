import { expect, test } from "bun:test";
import { vcaUniverse } from "./universe";
import { resolveOptionScreenListings } from "../../../market-data/options-listings";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { usListingsOnlyNote } from "../../../utils/sec";

test("an FX pair typed into the screen's symbols says what stands in for it, whether it is the only symbol or one of several", () => {
  const only = vcaUniverse("custom", "EURUSD=X", null, []);
  expect(only.instruments).toEqual([]);
  expect(only.error).toBe("OTC FX volatility is not covered for EURUSD=X. Currency-ETF options are the listed proxy and give an ATM IV30 only, no 25-delta risk reversal or butterfly: FXE. HVT shows the pair's realized volatility.");
  const mixed = vcaUniverse("custom", "SPY, 6J=F", null, []);
  expect(mixed.instruments.map((instrument) => instrument.symbol)).toEqual(["SPY"]);
  expect(mixed.error).toContain("Options on CME yen futures (6J=F) are not served.");
  // Symbols that are no FX keep the generic answer.
  expect(vcaUniverse("custom", "", null, []).error).toBe("Add symbols in pane settings.");
});

test("a pasted screen list resolves a bare primary without confusing listings that share its code", async () => {
  const getQuote = async (symbol: string) => {
    if (symbol !== "PIRC") throw new Error(`Unexpected quote for ${symbol}`);
    return createTestQuote({ symbol, listingExchangeName: "BIT" });
  };
  const provider = createTestDataProvider({ getQuote, knownUsStock: (symbol) => symbol === "SAN" });
  const { instruments } = vcaUniverse("custom", "PIRC, SAN, SAN:EPA, PIRC:BIT", null, []);
  const resolved = await resolveOptionScreenListings(instruments, provider);
  const notes = resolved.map(({ symbol, exchange }) => usListingsOnlyNote("Implied volatility", symbol, exchange));
  expect(resolved.map(({ symbol, exchange }) => ({ symbol, exchange }))).toEqual([
    { symbol: "PIRC", exchange: "BIT" }, { symbol: "SAN", exchange: undefined },
    { symbol: "SAN", exchange: "EPA" }, { symbol: "PIRC", exchange: "BIT" },
  ]);
  expect(notes[0]).toContain("PIRC:BIT");
  expect(notes[0]).toBe(notes[3]);
  expect(notes[1]).toBeNull();
  expect(notes[2]).toContain("SAN:EPA");
});
