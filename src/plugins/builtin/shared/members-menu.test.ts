import { describe, expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import { MEMBER_DESTINATIONS, MEMBER_WATCHLIST_LIMIT, memberDestinationChoices, memberSymbols, planMemberWatchlist, uniqueWatchlistName } from "./members-menu";

const ticker = (symbol: string, watchlists: string[] = [], exchange = "NASDAQ"): TickerRecord => ({
  metadata: { ticker: symbol, exchange, currency: "USD", name: symbol, portfolios: [], watchlists, positions: [], custom: {}, tags: [] },
});

describe("members menu", () => {
  test("each destination takes the first symbols as listed up to its own limit, and CORR needs two", () => {
    const many = memberSymbols(Array.from({ length: 70 }, (_, index) => ({ symbol: `s${index}` })));
    const choices = Object.fromEntries(memberDestinationChoices(many, MEMBER_DESTINATIONS).map((choice) => [choice.id, choice]));
    // RRG refuses more than 24 and SIW cuts off after 60; CORR and RIPL resolve a list of at most 10.
    expect(choices["relative-rotation-rrg"]!.symbols).toEqual(many.slice(0, 24));
    expect(choices["correlation-pane"]!.symbols).toEqual(many.slice(0, 10));
    expect(choices["short-watch-pane"]!.symbols).toHaveLength(60);
    expect(choices["earnings-ripple-pane"]!.symbols).toHaveLength(10);
    expect(choices["correlation-pane"]!.description).toBe("First 10 of 70 as listed");

    // A bare CCJ also matches Xetra, so a named listing travels with the symbol.
    expect(memberSymbols([{ symbol: "ccj", exchange: "NYSE" }, { symbol: "CCJ" }, { symbol: "BRK-B" }])).toEqual(["CCJ:NYSE", "BRK-B"]);
    const one = memberDestinationChoices(memberSymbols([{ symbol: "aapl" }, { symbol: "AAPL" }]), MEMBER_DESTINATIONS);
    expect(one.find((choice) => choice.id === "correlation-pane")!.disabled).toBe(true);
    expect(one.find((choice) => choice.id === "relative-rotation-rrg")).toMatchObject({ disabled: false, symbols: ["AAPL"], description: "All 1" });
  });

  test("a watchlist adds existing tickers, creates the rest once, and stops at the save limit", () => {
    const tickers = new Map([["AAPL", ticker("AAPL")], ["MSFT", ticker("MSFT", ["nuke"])]]);
    const plan = planMemberWatchlist(tickers, "nuke", [{ symbol: "AAPL" }, { symbol: "MSFT" }, { symbol: "ccj", name: "Cameco", exchange: "NYSE" }, { symbol: "CCJ" }]);
    expect(plan.update.map((row) => row.metadata.watchlists)).toEqual([["nuke"]]);
    expect(plan.create).toEqual([expect.objectContaining({ ticker: "CCJ", name: "Cameco", exchange: "NYSE", currency: "USD", watchlists: ["nuke"] })]);
    expect(plan.count).toBe(3);

    // A CCJ saved from Xetra keeps its record; the NYSE member gets its own listing, as search opens one.
    const listed = planMemberWatchlist(new Map([["CCJ", ticker("CCJ", [], "XETRA")]]), "nuke", [{ symbol: "CCJ", exchange: "NYSE" }]);
    expect(listed.update).toEqual([]);
    expect(listed.create).toEqual([expect.objectContaining({ ticker: "CCJ:XNYS", exchange: "NYSE" })]);

    const large = planMemberWatchlist(new Map(), "iwm", Array.from({ length: MEMBER_WATCHLIST_LIMIT + 5 }, (_, index) => ({ symbol: `S${index}` })));
    expect(large.create).toHaveLength(MEMBER_WATCHLIST_LIMIT);
  });

  test("a saved name never reuses a watchlist's name or id", () => {
    const lists = [{ id: "nuclear-uranium", name: "Nuclear & uranium" }, { id: "nuclear-uranium-2", name: "Other" }];
    // The name collides with the first list, "nuclear & uranium 2" with the second id.
    expect(uniqueWatchlistName("nuclear & uranium", lists)).toBe("nuclear & uranium 3");
    expect(uniqueWatchlistName(" Gold ", lists)).toBe("Gold");
  });
});
