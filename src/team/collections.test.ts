import { describe, expect, test } from "bun:test";
import type { TeamCollection, TeamCollectionItem } from "../api-client";
import { createDefaultConfig } from "../types/config";
import type { TickerRecord } from "../types/ticker";
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
