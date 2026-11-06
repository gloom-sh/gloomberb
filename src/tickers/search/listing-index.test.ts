import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import type { InstrumentSearchResult } from "../../types/instrument";
import { buildTickerSearchCandidates } from "./index";
import {
  answeredInFull,
  attachListingIndex,
  type KeptListing,
  installListingDirectory,
  knownListings,
  listingIndexKey,
  refreshListingDirectory,
  rememberSearchAnswer,
  resetListingIndexForTests,
} from "./listing-index";
import { MAJOR_LISTINGS } from "./major-listings.chunk";
import { getSearchResultSymbol } from "./result";

const DAY = 24 * 60 * 60_000;

afterEach(() => {
  setSystemTime();
});

function row(symbol: string, name: string, exchange: string, extra: Partial<InstrumentSearchResult> = {}): InstrumentSearchResult {
  return { providerId: "gloomberb-cloud", symbol, name, exchange, type: "Common Stock", currency: "USD", ...extra };
}

/** A plugin state store kept in memory, as the app's local store keeps it across launches. */
function memoryState() {
  const values = new Map<string, unknown>();
  return {
    get: <T,>(owner: string, key: string) => (values.has(`${owner}/${key}`)
      ? { value: values.get(`${owner}/${key}`) as T, schemaVersion: 2, updatedAt: 0 }
      : null),
    set: (owner: string, key: string, value: unknown) => { values.set(`${owner}/${key}`, value); },
  } as never;
}

/** The index over `shipped`, attached to a store kept in memory as the app attaches it to its local store. */
function launch(shipped: KeptListing[], pluginState: never = memoryState()) {
  installListingDirectory(shipped);
  const detach = attachListingIndex({ pluginState, writable: true });
  return {
    /** Saves what the index holds and starts it over from what was saved. */
    relaunch: () => {
      detach();
      resetListingIndexForTests();
      return launch(shipped, pluginState);
    },
  };
}

/** The symbol's line the command bar ranks first among `rows`. */
function rankedTop(symbol: string, rows: InstrumentSearchResult[]): string | undefined {
  const top = buildTickerSearchCandidates({ query: symbol, tickers: new Map(), providerResults: rows, totalLimit: rows.length + 1 })
    .find((candidate) => candidate.result && listingIndexKey(getSearchResultSymbol(candidate.result)) === listingIndexKey(symbol));
  return top?.result && `${top.result.name} ${top.result.exchange}`;
}

test("an answer outlives the launch as search sent it, ranked as it was, and leaves a broker's contracts out", () => {
  const app = launch([["SIVE", "Old Name AB", "SFB", "Common Stock", "SEK", null, 1, null]]);
  const delisting = { status: "inactive" as const, lastTradeDate: "2022-03-14", historyStart: "2016-01-04" };
  rememberSearchAnswer("sive", [
    row("SIVE", "Sivers Semiconductors AB", "SFB", { currency: "SEK", popularity: 120 }),
    row("SIVE", "Sivers via the broker", "SFB", { brokerInstanceId: "ibkr-1" }),
    row("SIVR", "abrdn Silver ETF", "ARCA"),
  ], true);
  // Dollar General leads by how often it is searched; without that, Vinci's home line would.
  const dg = [
    row("DG", "Dollar General Corporation", "NYSE", { homeListing: true, popularity: 13_617_000 }),
    row("DG", "Vinci SA", "EPA", { currency: "EUR", homeListing: true }),
    row("DG", "Vinci SA", "VIE", { currency: "EUR" }),
    row("DG", "VINCI SA", "SWX", { currency: "CHF" }),
  ];
  rememberSearchAnswer("DG", dg, true);
  rememberSearchAnswer("TWTR", [row("TWTR", "Twitter, Inc.", "NYSE", { providerId: "yahoo", delisting })], true);
  app.relaunch();

  expect(knownListings("SIVE")).toEqual([row("SIVE", "Sivers Semiconductors AB", "SFB", { currency: "SEK", popularity: 120 })]);
  expect(rankedTop("DG", dg)).toBe("Dollar General Corporation NYSE");
  expect(rankedTop("DG", knownListings("DG"))).toBe("Dollar General Corporation NYSE");
  expect(knownListings("TWTR")[0]).toMatchObject({ providerId: "yahoo", delisting });
  // Every spelling of a symbol finds it, and a class is not the letters it follows.
  rememberSearchAnswer("NOVO-B", [row("NOVO.B", "Novo Nordisk A/S", "CPH")], true);
  expect(knownListings("novo b").map((listing) => listing.symbol)).toEqual(["NOVO.B"]);
  rememberSearchAnswer("BT.A", [row("BT.A", "BT Group plc", "LSE"), row("BTA", "Beacon Tactical Alternatives Risk ETF", "NYSE")], true);
  expect(knownListings("BT-A").map((listing) => listing.name)).toEqual(["BT Group plc"]);
  expect(knownListings("BTA")).toEqual([]);
});

test("an answer stands two weeks unconfirmed, and one search gave in full without the symbol takes it away", () => {
  let app = launch([["ACME", "Acme Shipped", "NYSE", "Common Stock", "USD", null, 1, null]]);
  setSystemTime(new Date(Date.UTC(2026, 0, 1)));
  rememberSearchAnswer("ACME", [row("ACME", "Acme Searched", "NYSE")], true);
  rememberSearchAnswer("WIDG", [row("WIDG", "Widget Co", "NASDAQ")], true);
  // One that may have been cut short says nothing about what is listed: the service was busy,
  // or a keystroke gave it up and another source, or a broker, answered.
  const without = (extra: Partial<InstrumentSearchResult>) => [row("WIDGX", "Widget Fund", "NASDAQ", extra)];
  for (const [rows, cutShort] of [[without({}), true], [without({ providerId: "yahoo" }), false], [without({ brokerInstanceId: "ibkr-live" }), false]] as const) {
    rememberSearchAnswer("WIDG", rows, answeredInFull(rows, cutShort));
  }
  expect(knownListings("WIDG").map((listing) => listing.name)).toEqual(["Widget Co"]);
  // The data service's whole answer, with the symbol's line gone, takes it away.
  rememberSearchAnswer("WIDG", without({}), answeredInFull(without({}), false));
  expect(knownListings("WIDG")).toEqual([]);

  setSystemTime(new Date(Date.UTC(2026, 0, 14)));
  app = app.relaunch();
  expect(knownListings("ACME").map((listing) => listing.name)).toEqual(["Acme Searched"]);
  setSystemTime(new Date(Date.UTC(2026, 0, 16)));
  expect(knownListings("ACME").map((listing) => listing.name)).toEqual(["Acme Shipped"]);
  app.relaunch();
  expect(knownListings("ACME").map((listing) => listing.name)).toEqual(["Acme Shipped"]);
});

test("a daily refresh re-reads the next slice, and a slice search did not answer in full is asked again", async () => {
  installListingDirectory([
    ["AAA", "Old A", "NYSE", "Common Stock", "USD", null, 1, null],
    ["BBB", "Old B", "NYSE", "Common Stock", "USD", null, 1, null],
    ["CCC", "Gone C", "NYSE", "Common Stock", "USD", null, 1, null],
  ]);
  const now = 10 * DAY;
  setSystemTime(new Date(now));
  rememberSearchAnswer("BBB", [row("BBB", "Searched B", "NYSE")], true);
  const asked: string[][] = [];
  const fresh = async (queries: string[]) => {
    asked.push(queries);
    return new Map(queries.map((query) => [query, query === "CCC" ? [] : [row(query, `Fresh ${query}`, "NASDAQ")]]));
  };
  // The request failed, a source cannot batch, or the service left a query out: the day does not move on.
  expect(await refreshListingDirectory(async () => { throw new Error("offline"); }, now)).toBe("failed");
  expect(await refreshListingDirectory(async () => null, now)).toBe("failed");
  expect(await refreshListingDirectory(async (queries) => new Map([[queries[0]!, [row(queries[0]!, "Partial A", "NYSE")]]]), now)).toBe("failed");
  expect(knownListings("AAA").map((listing) => listing.name)).toEqual(["Partial A"]);

  expect(await refreshListingDirectory(fresh, now + 1)).toBe("refreshed");
  expect(asked).toEqual([["AAA", "BBB", "CCC"]]);
  // What was read or searched within the day stands.
  expect(knownListings("AAA").map((listing) => listing.name)).toEqual(["Partial A"]);
  expect(knownListings("BBB").map((listing) => listing.name)).toEqual(["Searched B"]);
  // A symbol search no longer finds is no longer offered.
  expect(knownListings("CCC")).toEqual([]);
  expect(await refreshListingDirectory(fresh, now + DAY / 2)).toBe("not-due");
  expect(asked).toHaveLength(1);
});

test("the refresh runs only while the app can be seen, and comes back for a slice that failed", async () => {
  jest.useFakeTimers();
  try {
    installListingDirectory([["AAA", "Old A", "NYSE", "Common Stock", "USD", null, 1, null]]);
    let visible = false;
    const listeners = new Set<() => void>();
    const show = (next: boolean) => { visible = next; for (const listener of listeners) listener(); };
    let fails = true;
    const asked: string[][] = [];
    const detach = attachListingIndex({
      pluginState: memoryState(),
      writable: true,
      searchBatch: async (queries) => {
        asked.push(queries);
        return fails ? null : new Map(queries.map((query) => [query, [row(query, `Fresh ${query}`, "NYSE")]]));
      },
      visibility: { isVisible: () => visible, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
    });
    const wait = async (ms: number) => {
      jest.advanceTimersByTime(ms);
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    };
    await wait(10 * 60_000);
    expect(asked).toHaveLength(0);
    show(true);
    await wait(2 * 60_000);
    expect(asked).toHaveLength(1);
    fails = false;
    await wait(15 * 60_000);
    expect(asked).toHaveLength(2);
    expect(knownListings("AAA").map((listing) => listing.name)).toEqual(["Fresh AAA"]);
    // Done for the day.
    await wait(60 * 60_000);
    expect(asked).toHaveLength(2);
    detach();
  } finally {
    jest.useRealTimers();
  }
});

test("a symbol several companies use keeps a line of each, ahead of one company's other venues", () => {
  const carrefour = ["XETRA", "XSTU", "FWB2", "MUNICH", "HANOVER", "XDUS"].map((venue) => row("CAR", "Carrefour SA", venue));
  rememberSearchAnswer("CAR", [row("CAR", "Avis Budget Group, Inc.", "NASDAQ"), ...carrefour, row("CAR", "CAR Group Limited", "ASX")], true);
  expect(knownListings("CAR").map((listing) => listing.name)).toContain("CAR Group Limited");
  expect(knownListings("CAR")).toHaveLength(6);
});

test("every shipped symbol ranks first the line search's whole answer ranked first when the list was made", () => {
  installListingDirectory(MAJOR_LISTINGS);
  const symbols = [...new Set(MAJOR_LISTINGS.map((listing) => listingIndexKey(listing[0])))];
  expect(symbols.length).toBeGreaterThan(900);
  const wrong = symbols.flatMap((key) => {
    const lines = knownListings(key);
    const first = `${lines[0]?.name} ${lines[0]?.exchange}`;
    return rankedTop(key, lines) === first ? [] : [`${key}: ${rankedTop(key, lines)} instead of ${first}`];
  });
  expect(wrong).toEqual([]);
});
