import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestDataProvider } from "../test-support/data-provider";
import { ListingArgError, parseListingArg, resolveCliListing } from "./listing-arg";

const persistences: AppPersistence[] = [];

afterEach(() => {
  for (const persistence of persistences.splice(0)) persistence.close();
});

test("SYM:EXCH and --exchange name the same listing through the exchange aliases, and must agree", () => {
  for (const [raw, option] of [["san:xpar", undefined], ["SAN", "XPAR"], ["SAN:EPA", "epa"], ["SAN:", "EPA"], [" $San:Par ", "EPA"]] as const) {
    expect(parseListingArg(raw, option)).toEqual({ symbol: "SAN", exchange: "EPA", key: "SAN:EPA" });
  }
  expect(parseListingArg("aapl")).toEqual({ symbol: "AAPL", exchange: "", key: "AAPL" });
  expect(() => parseListingArg("SAN:EPA", "LON")).toThrow("SAN:EPA names exchange EPA, but --exchange names LSE.");
  // With several symbols, --exchange only fills in the ones without their own.
  expect(parseListingArg("SAN:EPA", "LSE", { ownExchangeWins: true }).key).toBe("SAN:EPA");
});

test("an exchange code the app does not know is refused unless the symbol trades there", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", symbol: "SAN", currency: "EUR", type: "Common Stock" };
  const dataProvider = createTestDataProvider({
    search: async () => [
      { ...row, name: "Banco Santander, S.A. Sponsored ADR", exchange: "NYSE", currency: "USD" },
      { ...row, name: "Sanofi SA", exchange: "EPA" },
      { ...row, name: "Banco Santander, S.A.", exchange: "BVL" },
    ],
  });
  const deps = { store, dataProvider };

  const refused = await resolveCliListing("SAN:ZZZ", undefined, deps).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ListingArgError);
  expect((refused as Error).message).toBe("Unknown exchange ZZZ for SAN. SAN trades on: NYSE, EPA, BVL.");
  // A venue only search knows is still the symbol's own listing; data requests go by its key.
  expect((await resolveCliListing("SAN", "BVL", deps)).request).toEqual({ symbol: "SAN:BVL", exchange: "BVL" });

  // A bare symbol keeps the listing it was saved with, as the ticker report always did.
  await store.createTicker({
    ticker: "SAN", exchange: "EPA", currency: "EUR", name: "Sanofi", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
  });
  const saved = await resolveCliListing("SAN", undefined, deps);
  expect(saved.request).toEqual({ symbol: "SAN", exchange: "EPA" });
  expect((await resolveCliListing("SAN:XPAR", undefined, deps)).saved?.metadata.name).toBe("Sanofi");
  expect((await resolveCliListing("SAN:NYSE", undefined, deps)).saved).toBeNull();
});
