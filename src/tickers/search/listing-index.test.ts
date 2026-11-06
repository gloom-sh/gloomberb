import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../../types/instrument";
import {
  attachListingIndex,
  installListingDirectory,
  knownListings,
  refreshListingDirectory,
  rememberSearchAnswer,
  resetListingIndexForTests,
} from "./listing-index";

const DAY = 24 * 60 * 60_000;

function row(symbol: string, name: string, exchange: string, extra: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult {
  return { providerId: "gloomberb-cloud", symbol, name, exchange, type: "Common Stock", currency: "USD", ...extra };
}

/** A plugin state store kept in memory, as the app's local store keeps it across launches. */
function memoryState() {
  const values = new Map<string, unknown>();
  return {
    values,
    pluginState: {
      get: <T,>(owner: string, key: string) => (values.has(`${owner}/${key}`)
        ? { value: values.get(`${owner}/${key}`) as T, schemaVersion: 1, updatedAt: 0 }
        : null),
      set: (owner: string, key: string, value: unknown) => { values.set(`${owner}/${key}`, value); },
    },
  };
}

test("what search answered outlives the launch, ahead of the shipped lines, and leaves a broker's contracts out", () => {
  installListingDirectory([["SIVE", "Old Name AB", "SFB", "Common Stock", "SEK", null, 1]]);
  const { pluginState } = memoryState();
  const detach = attachListingIndex({ pluginState: pluginState as never, writable: true });
  rememberSearchAnswer("sive", [
    row("SIVE", "Sivers Semiconductors AB", "SFB", { currency: "SEK" }),
    row("SIVE", "Sivers via the broker", "SFB", { brokerInstanceId: "ibkr-1" }),
    row("SIVR", "abrdn Silver ETF", "ARCA"),
  ]);
  // An answer with no line of the symbol keeps what was known.
  rememberSearchAnswer("SIVE", [row("SIVR", "abrdn Silver ETF", "ARCA")]);
  detach();

  resetListingIndexForTests();
  attachListingIndex({ pluginState: pluginState as never, writable: false });
  expect(knownListings("SIVE").map((listing) => [listing.name, listing.currency])).toEqual([["Sivers Semiconductors AB", "SEK"]]);
  // Every spelling of a symbol finds it.
  rememberSearchAnswer("NOVO-B", [row("NOVO.B", "Novo Nordisk A/S", "CPH")]);
  expect(knownListings("novo b").map((listing) => listing.symbol)).toEqual(["NOVO.B"]);
});

test("a daily refresh re-reads the next slice of the shipped symbols, leaving alone what was searched that day", async () => {
  installListingDirectory([
    ["AAA", "Old A", "NYSE", "Common Stock", "USD", null, 1],
    ["BBB", "Old B", "NYSE", "Common Stock", "USD", null, 1],
    ["CCC", "Gone C", "NYSE", "Common Stock", "USD", null, 1],
  ]);
  const now = 10 * DAY;
  rememberSearchAnswer("BBB", [row("BBB", "Searched B", "NYSE")]);
  const asked: string[][] = [];
  const searchBatch = async (queries: string[]) => {
    asked.push(queries);
    return new Map(queries.map((query) => [query, query === "CCC" ? [] : [row(query, `Fresh ${query}`, "NASDAQ")]]));
  };
  await refreshListingDirectory(searchBatch, now);
  expect(knownListings("AAA").map((listing) => listing.name)).toEqual(["Fresh AAA"]);
  expect(knownListings("BBB").map((listing) => listing.name)).toEqual(["Searched B"]);
  // A symbol search no longer finds is no longer offered.
  expect(knownListings("CCC")).toEqual([]);
  // Once a day.
  await refreshListingDirectory(searchBatch, now + DAY / 2);
  expect(asked).toHaveLength(1);
  // A service that cannot batch leaves it for the next launch.
  await refreshListingDirectory(async () => null, now + DAY);
  await refreshListingDirectory(searchBatch, now + DAY);
  expect(asked).toHaveLength(2);
});

test("a symbol several companies use keeps a line of each, ahead of one company's other venues", () => {
  const carrefour = ["XETRA", "XSTU", "FWB2", "MUNICH", "HANOVER", "XDUS"].map((venue) => row("CAR", "Carrefour SA", venue));
  rememberSearchAnswer("CAR", [row("CAR", "Avis Budget Group, Inc.", "NASDAQ"), ...carrefour, row("CAR", "CAR Group Limited", "ASX")]);
  expect(knownListings("CAR").map((listing) => `${listing.name} ${listing.exchange}`)).toEqual([
    "Avis Budget Group, Inc. NASDAQ",
    "Carrefour SA XETRA",
    "Carrefour SA XSTU",
    "Carrefour SA FWB2",
    "Carrefour SA MUNICH",
    "CAR Group Limited ASX",
  ]);
});
