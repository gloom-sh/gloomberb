import { describe, expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import { screenWatchlistList } from "../equity-screener/watchlist";
import { SCREEN_IDEAS } from "../equity-screener/ideas";
import {
  MEMBER_DESTINATIONS, MEMBER_WATCHLIST_LIMIT, memberDestinationChoices, memberListText, memberSymbols, NEW_WATCHLIST_CHOICE,
  planMemberWatchlist, uniqueWatchlistName, watchlistTargetChoices,
} from "./members-menu";

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

  test("the save dialog offers a new watchlist, then each one there is with its count", () => {
    const tickers = new Map([["AAPL", ticker("AAPL", ["core", "tech"])], ["MSFT", ticker("MSFT", ["tech"])]]);
    expect(watchlistTargetChoices([{ id: "core", name: "Core" }, { id: "tech", name: "Tech" }, { id: "empty", name: "Empty" }], tickers)).toEqual([
      { id: NEW_WATCHLIST_CHOICE, label: "New watchlist…" },
      { id: "core", label: "Core", detail: "1 tickers" },
      { id: "tech", label: "Tech", detail: "2 tickers" },
      { id: "empty", label: "Empty", detail: "0 tickers" },
    ]);
  });

  test("a screen's matches save as listed: the first 100 of all that match, each in its own currency", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ symbol: `S${index}`, name: null, exchange: "LSE", currency: "GBp" }));
    const magic = SCREEN_IDEAS.find((idea) => idea.id === "magic-formula")!;
    const list = screenWatchlistList({ definition: magic.definition, rows, matched: 230 })!;
    expect(list).toMatchObject({ title: "Magic Formula top", watchlistName: "Magic Formula top", noun: "matches", openIn: false });
    expect(memberListText(list, 100)).toMatchObject({
      saveTitle: "Save Magic Formula top matches to",
      saveBody: "The first 100 of 230 matches, as listed.",
    });
    expect(memberListText({ ...list, total: 3 }, 3).saveBody).toBe("All 3 matches.");
    // A theme's or fund's members read as they did.
    expect(memberListText({ title: "IVV" }, 503).saveBody).toBe("The first 100 of 503 members, as listed.");
    expect(planMemberWatchlist(new Map(), "uk", list.members).create[0]).toMatchObject({ ticker: "S0", exchange: "LSE", currency: "GBp" });
    const edited = { ...magic.definition, criteria: [] };
    expect(screenWatchlistList({ definition: edited, rows, matched: 230, savedName: "Cheap UK" })!.title).toBe("Cheap UK");
    expect(screenWatchlistList({ definition: edited, rows, matched: 230 })!.watchlistName).toBe("EQS screen");
    expect(screenWatchlistList({ definition: edited, rows: [], matched: 0 })).toBeNull();
  });

  test("a saved name never reuses a watchlist's name or id", () => {
    const lists = [{ id: "nuclear-uranium", name: "Nuclear & uranium" }, { id: "nuclear-uranium-2", name: "Other" }];
    // The name collides with the first list, "nuclear & uranium 2" with the second id.
    expect(uniqueWatchlistName("nuclear & uranium", lists)).toBe("nuclear & uranium 3");
    expect(uniqueWatchlistName(" Gold ", lists)).toBe("Gold");
  });
});
