import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestDataProvider } from "../test-support/data-provider";
import { ListingArgError, loadForListing, parseListingArg, resolveCliListing } from "./listing-arg";

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

test("a request for an exchange the symbol is not listed on ends in where it trades, and only a miss looks the venues up", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const row = { providerId: "test", symbol: "SAN", currency: "EUR", type: "Common Stock" };
  let searches = 0;
  const dataProvider = createTestDataProvider({
    search: async () => {
      searches += 1;
      return [{ ...row, name: "Banco Santander", exchange: "NYSE" }, { ...row, name: "Sanofi SA", exchange: "EPA" }];
    },
  });
  const deps = { store, dataProvider };
  const ctx = { fail: (message: string): never => { throw new ListingArgError(message); } };
  const listing = (raw: string) => resolveCliListing(raw, undefined, deps);
  const failed = new Error("No provider available for SAN:TSX");

  // TSX is a code the app knows, so the exchange check lets it through; the data request is what comes back empty.
  const tsx = await listing("SAN:TSX");
  searches = 0;
  expect(await loadForListing(tsx, deps, ctx, async () => ["bar"], (bars) => bars.length === 0)).toEqual(["bar"]);
  expect(searches).toBe(0);

  const message = "SAN does not trade on TSX. SAN trades on: NYSE, EPA.";
  await expect(loadForListing(tsx, deps, ctx, async () => { throw failed; })).rejects.toThrow(message);
  await expect(loadForListing(tsx, deps, ctx, async () => [], (bars) => bars.length === 0)).rejects.toThrow(message);

  // A listed venue keeps the request's own failure, and a bare symbol names no venue to check.
  await expect(loadForListing(await listing("SAN:EPA"), deps, ctx, async () => { throw failed; })).rejects.toBe(failed);
  searches = 0;
  await expect(loadForListing(await listing("SAN"), deps, ctx, async () => { throw failed; })).rejects.toBe(failed);
  expect(searches).toBe(0);
});
