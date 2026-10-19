import { describe, expect, test } from "bun:test";
import type { TeamCollection, TeamCollectionItem } from "../api-client";
import { createDefaultConfig } from "../types/config";
import type { TickerPosition, TickerRecord } from "../types/ticker";
import {
  applyMembership,
  blankTickerRecord,
  diffMembership,
  localMembership,
  parseCollectionRef,
  reconcileConfigCollections,
  teamCollectionLocalId,
} from "./collections";

function collection(overrides: Partial<TeamCollection>): TeamCollection {
  return {
    id: "c1",
    teamId: "org-1",
    kind: "watchlist",
    name: "Rates names",
    currency: null,
    createdBy: "u1",
    createdAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
    itemCount: 0,
    ...overrides,
  };
}

function item(symbol: string, quantity: number | null = null): TeamCollectionItem {
  return {
    collectionId: "c1",
    symbol,
    exchange: "",
    quantity,
    note: null,
    addedBy: "u1",
    addedAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T12:00:00.000Z",
  };
}

describe("scoped collection references", () => {
  test("bare ids are personal, team ids carry the team", () => {
    expect(parseCollectionRef("main")).toEqual({ scope: "user", id: "main" });
    expect(parseCollectionRef(teamCollectionLocalId("org-1", "c1"))).toEqual({ scope: "team", teamId: "org-1", id: "c1" });
    expect(parseCollectionRef("team:broken")).toEqual({ scope: "user", id: "team:broken" });
    expect(parseCollectionRef("team:org-1:")).toEqual({ scope: "user", id: "team:org-1:" });
  });
});

describe("reconcileConfigCollections", () => {
  test("replaces a team's entries and leaves personal and other teams alone", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-team-collections"),
      watchlists: [
        { id: "mine", name: "Mine" },
        { id: teamCollectionLocalId("org-2", "x"), name: "Other team", teamId: "org-2" },
        { id: teamCollectionLocalId("org-1", "stale"), name: "Stale", teamId: "org-1" },
      ],
      portfolios: [{ id: "main", name: "Main", currency: "USD" }],
    };
    const next = reconcileConfigCollections(config, ["org-1"], [
      collection({ id: "c1", name: "Rates names" }),
      collection({ id: "c2", kind: "portfolio", name: "Paper book", currency: "EUR" }),
    ]);
    expect(next.watchlists).toEqual([
      { id: "mine", name: "Mine" },
      { id: "team:org-2:x", name: "Other team", teamId: "org-2" },
      { id: "team:org-1:c1", name: "Rates names", teamId: "org-1" },
    ]);
    expect(next.portfolios).toEqual([
      { id: "main", name: "Main", currency: "USD" },
      { id: "team:org-1:c2", name: "Paper book", currency: "EUR", teamId: "org-1" },
    ]);
    expect(reconcileConfigCollections(next, ["org-1"], [
      collection({ id: "c1", name: "Rates names" }),
      collection({ id: "c2", kind: "portfolio", name: "Paper book", currency: "EUR" }),
    ])).toBe(next);
  });
});

describe("membership", () => {
  const localId = teamCollectionLocalId("org-1", "c1");
  const aapl: TickerRecord = blankTickerRecord("AAPL", "NASDAQ", "USD");

  test("applies watchlist adds and removes only when something changes", () => {
    const added = applyMembership(aapl, localId, "watchlist", item("AAPL"), "USD");
    expect(added?.metadata.watchlists).toEqual([localId]);
    expect(applyMembership(added!, localId, "watchlist", item("AAPL"), "USD")).toBeNull();
    const removed = applyMembership(added!, localId, "watchlist", null, "USD");
    expect(removed?.metadata.watchlists).toEqual([]);
    expect(applyMembership(aapl, localId, "watchlist", null, "USD")).toBeNull();
  });

  test("paper portfolio items carry a manual position with the quantity", () => {
    const added = applyMembership(aapl, localId, "portfolio", item("AAPL", 10), "EUR");
    expect(added?.metadata.portfolios).toEqual([localId]);
    expect(added?.metadata.positions).toEqual([
      { portfolio: localId, shares: 10, avgCost: 0, currency: "EUR", broker: "manual" },
    ]);
    const updated = applyMembership(added!, localId, "portfolio", item("AAPL", 12), "EUR");
    expect(updated?.metadata.positions[0]?.shares).toBe(12);
    expect(applyMembership(updated!, localId, "portfolio", item("AAPL", 12), "EUR")).toBeNull();
    const cleared = applyMembership(updated!, localId, "portfolio", null, "EUR");
    expect(cleared?.metadata.portfolios).toEqual([]);
    expect(cleared?.metadata.positions).toEqual([]);
  });

  test("reads local membership and diffs it against the known server set", () => {
    const inList = applyMembership(aapl, localId, "portfolio", item("AAPL", 10), "USD")!;
    const msft = applyMembership(blankTickerRecord("MSFT", "", "USD"), localId, "portfolio", item("MSFT", 3), "USD")!;
    const tickers = new Map<string, TickerRecord>([["AAPL", inList], ["MSFT", msft], ["TSLA", blankTickerRecord("TSLA", "", "USD")]]);
    const local = localMembership(tickers, localId, "portfolio");
    expect([...local.keys()]).toEqual(["AAPL", "MSFT"]);
    expect(local.get("AAPL")?.quantity).toBe(10);

    const known = new Map([["AAPL", item("AAPL", 10)], ["NVDA", item("NVDA", 1)]]);
    expect(diffMembership(local, known)).toEqual({
      add: [{ symbol: "MSFT", quantity: 3 }],
      remove: ["NVDA"],
    });
    const knownStale = new Map([["AAPL", item("AAPL", 8)]]);
    expect(diffMembership(local, knownStale).add.map((entry) => entry.symbol)).toEqual(["AAPL", "MSFT"]);
  });
});

describe("membership of a ticker held in several lots", () => {
  const localId = teamCollectionLocalId("org-1", "c1");
  const lot = (shares: number, avgCost: number, extra: Partial<TickerPosition> = {}): TickerPosition =>
    ({ portfolio: localId, shares, avgCost, currency: "USD", broker: "manual", ...extra });
  const held = (...positions: TickerPosition[]): TickerRecord => ({
    metadata: { ...blankTickerRecord("AAPL", "NASDAQ", "USD").metadata, portfolios: [localId], positions },
  });
  const twoLots = held(lot(10, 150, { dateAcquired: "2024-01-02" }), lot(5, 170, { dateAcquired: "2024-06-03" }));

  test("sends the total of the lots, not the first lot's shares", () => {
    const local = localMembership(new Map([["AAPL", twoLots]]), localId, "portfolio");
    expect(local.get("AAPL")?.quantity).toBe(15);
    expect(diffMembership(local, new Map([["AAPL", item("AAPL", 15)]]))).toEqual({ add: [], remove: [] });
    expect(diffMembership(local, new Map([["AAPL", item("AAPL", 10)]])).add).toEqual([{ symbol: "AAPL", quantity: 15 }]);
  });

  test("an equal server quantity leaves the lots alone, and a different one collapses them to the weighted cost", () => {
    expect(applyMembership(twoLots, localId, "portfolio", item("AAPL", 15), "USD")).toBeNull();

    const collapsed = applyMembership(twoLots, localId, "portfolio", item("AAPL", 20), "USD")!;
    expect(collapsed.metadata.positions).toHaveLength(1);
    expect(collapsed.metadata.positions[0]).toEqual({
      portfolio: localId, shares: 20, avgCost: 156.666666666667, currency: "USD", broker: "manual",
    });
  });

  test("lots that cannot be totalled are never rewritten from a quantity, and send none", () => {
    const mixed = held(lot(10, 150), lot(5, 140, { currency: "EUR" }));
    const local = localMembership(new Map([["AAPL", mixed]]), localId, "portfolio");
    expect(local.get("AAPL")).toMatchObject({ quantity: null, lotsNotTotalled: true });
    // The server keeps what it has; a ticker it lacks goes up without a quantity.
    expect(diffMembership(local, new Map([["AAPL", item("AAPL", 15)]]))).toEqual({ add: [], remove: [] });
    expect(diffMembership(local, new Map()).add).toEqual([{ symbol: "AAPL", quantity: null }]);

    for (const quantity of [20, null]) expect(applyMembership(mixed, localId, "portfolio", item("AAPL", quantity), "USD")).toBeNull();
    const shorted = held(lot(10, 150), lot(5, 170, { side: "short" }));
    expect(applyMembership(shorted, localId, "portfolio", item("AAPL", 20), "USD")).toBeNull();
    // Removing the item from the collection still takes its lots with it.
    expect(applyMembership(mixed, localId, "portfolio", null, "USD")?.metadata.positions).toEqual([]);
  });

  test("a short future goes up as a negative quantity and comes back a short of the same contract size", () => {
    const gold = (shares: number, extra: Partial<TickerPosition> = {}): TickerRecord => ({
      metadata: { ...blankTickerRecord("GC=F", "CMX", "USD").metadata, assetCategory: "FUTURE", portfolios: [localId],
        positions: [lot(shares, 4216.3, { multiplier: 100, dateAcquired: "2026-10-01", ...extra })] },
    });
    const short = gold(-5);
    const local = localMembership(new Map([["GC=F", short]]), localId, "portfolio");
    expect(diffMembership(local, new Map()).add).toEqual([{ symbol: "GC=F", quantity: -5 }]);
    // The server stores and returns the sign, so the pull that follows the push changes nothing.
    expect(applyMembership(short, localId, "portfolio", item("GC=F", -5), "USD")).toBeNull();
    // A teammate's new count keeps the cost, the date and the contract size.
    expect(applyMembership(short, localId, "portfolio", item("GC=F", -7), "USD")?.metadata.positions).toEqual([
      lot(-7, 4216.3, { multiplier: 100, dateAcquired: "2026-10-01" }),
    ]);
    // One that turns the short into a long is another position: the short's cost and date go, the size stays.
    expect(applyMembership(short, localId, "portfolio", item("GC=F", 3), "USD")?.metadata.positions).toEqual([
      { portfolio: localId, shares: 3, currency: "USD", broker: "manual", multiplier: 100 },
    ]);
    // A short entered as a positive count on a short side goes up, and comes back, negative.
    const sided = gold(5, { side: "short" });
    expect(localMembership(new Map([["GC=F", sided]]), localId, "portfolio").get("GC=F")?.quantity).toBe(-5);
    expect(applyMembership(sided, localId, "portfolio", item("GC=F", -5), "USD")).toBeNull();
  });

  test("a single lot keeps its cost and date, and is rewritten only when the quantity changes", () => {
    const single = held(lot(10, 150, { dateAcquired: "2024-01-02" }));
    expect(localMembership(new Map([["AAPL", single]]), localId, "portfolio").get("AAPL")).toMatchObject({ quantity: 10 });
    expect(applyMembership(single, localId, "portfolio", item("AAPL", 10), "USD")).toBeNull();
    expect(applyMembership(single, localId, "portfolio", item("AAPL", 12), "USD")?.metadata.positions).toEqual([
      lot(12, 150, { dateAcquired: "2024-01-02" }),
    ]);
  });
});
