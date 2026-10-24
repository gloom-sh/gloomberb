import { expect, test } from "bun:test";
import { createDefaultConfig } from "../types/config";
import type { IssuerListings } from "../types/issuer-listings";
import { createTestTicker } from "../test-support/ticker";
import { companyMemberships, issuerListingKey, loadCompanyMemberships } from "./issuer-membership";

const config = {
  ...createDefaultConfig("/tmp/unused"),
  portfolios: [{ id: "main", name: "Main Portfolio", currency: "USD" }],
  watchlists: [{ id: "r", name: "R" }, { id: "telco", name: "Telco" }],
};
const rogersTsx = createTestTicker("RCI.B:TSX", "Rogers Communications Inc.", { exchange: "TSX", currency: "CAD", watchlists: ["r"] });
const rogersNyse = createTestTicker("RCI", "Rogers Communications Inc. Class B", { exchange: "NYSE", watchlists: ["telco"], portfolios: ["main"] });
const bell = createTestTicker("BCE", "BCE Inc.", { exchange: "NYSE", watchlists: ["r"] });
const rogers: IssuerListings = {
  issuer: "cik:733099",
  name: "Rogers Communications Inc.",
  country: "CA",
  listings: [
    { symbol: "RCI.B:TSX", exchange: "TSX", name: "Rogers Communications Inc.", primary: true },
    { symbol: "RCI.A:TSX", exchange: "TSX", name: "Rogers Communications Inc.", primary: false },
    { symbol: "RCI", exchange: "NYSE", name: "Rogers Communications Inc.", primary: false },
  ],
};
const keys = rogers.listings.map((listing) => issuerListingKey(listing.symbol, listing.exchange));

test("a list holding any listing of the company holds it, whichever listing is asked about, and says which listing it holds", () => {
  // Watchlist R held RCI.B:TSX, and `ticker RCI` said nothing of it.
  expect(companyMemberships(config, null, [rogersTsx, bell], keys)).toEqual({
    portfolios: [],
    watchlists: [{ name: "R", via: "RCI.B:TSX" }],
  });
  // The reverse, and a list holding both listings is named once, as the listing asked about.
  const bothInR = { ...rogersNyse, metadata: { ...rogersNyse.metadata, watchlists: ["telco", "r"] } };
  expect(companyMemberships(config, rogersTsx, [rogersTsx, bothInR, bell], keys)).toEqual({
    portfolios: [{ name: "Main Portfolio", via: "RCI:NYSE" }],
    watchlists: [{ name: "R", via: null }, { name: "Telco", via: "RCI:NYSE" }],
  });
  // Without the company's listings, only the listing's own lists.
  expect(companyMemberships(config, rogersNyse, [rogersTsx], null).watchlists).toEqual([{ name: "Telco", via: null }]);
});

test("a listing's key matches the issuer's spelling of it: bare in the US, SYMBOL:EXCHANGE abroad, a class with a dot", () => {
  expect([
    issuerListingKey("RCI", "NYSE"),
    issuerListingKey("BRK-B", "NYSE"),
    issuerListingKey("BRK/B", ""),
    issuerListingKey("RCI.B:TSX"),
    issuerListingKey("rci.b", "TSX"),
  ]).toEqual(["RCI", "BRK.B", "BRK.B", "RCI.B:TSX", "RCI.B:TSX"]);
});

test("the company's listings are asked for only when another saved listing is in a list, and a failed lookup keeps the listing's own lists", async () => {
  const asked: string[] = [];
  const dataProvider = {
    getIssuerListings: async (symbol: string, exchange?: string) => {
      asked.push(`${symbol}:${exchange}`);
      return rogers;
    },
  };
  const load = (saved: ReturnType<typeof createTestTicker>[], provider = dataProvider) => loadCompanyMemberships({
    config, own: null, symbol: "RCI", exchange: "NYSE", loadTickers: async () => saved, dataProvider: provider,
  });
  const unlisted = { ...rogersTsx, metadata: { ...rogersTsx.metadata, watchlists: [] } };
  expect(await load([unlisted])).toEqual({ portfolios: [], watchlists: [] });
  expect(asked).toEqual([]);
  expect((await load([rogersTsx])).watchlists).toEqual([{ name: "R", via: "RCI.B:TSX" }]);
  expect(asked).toEqual(["RCI:NYSE"]);
  const down = { getIssuerListings: async () => { throw new Error("offline"); } };
  expect(await load([rogersTsx], down)).toEqual({ portfolios: [], watchlists: [] });
});
