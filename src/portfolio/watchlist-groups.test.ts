import { expect, test } from "bun:test";
import { createDefaultConfig } from "../types/config";
import type { Watchlist } from "../types/ticker";
import {
  moveWatchlistGroupSymbols,
  normalizeWatchlistGroups,
  sectionWatchlistItems,
  setWatchlistGroup,
  withoutStaleWatchlistGroupSymbols,
  withoutWatchlistGroupSymbols,
} from "./watchlist-groups";
import { createTestTicker } from "../test-support/ticker";

function configWith(watchlist: Watchlist) {
  return { ...createDefaultConfig("/unused-watchlist-groups"), watchlists: [watchlist] };
}

test("saved or pulled groups keep what is well formed: one group per name in any case, each symbol in its first group, no empty group", () => {
  expect(normalizeWatchlistGroups([
    { name: " Energy ", symbols: ["XOM", "CVX"] },
    { name: "energy", symbols: ["OXY", 7] },
    { name: "Tech", symbols: ["XOM", "NVDA", " "] },
    { name: "", symbols: ["AAPL"] },
    { name: "Empty", symbols: [] },
    { symbols: ["MSFT"] },
    "Funds",
  ])).toEqual([
    { name: "Energy", symbols: ["XOM", "CVX", "OXY"] },
    { name: "Tech", symbols: ["NVDA"] },
  ]);
  // Nothing left is no groups at all, so the list saves and syncs as one without groups.
  expect(normalizeWatchlistGroups([{ name: "Empty", symbols: [] }])).toBeUndefined();
  expect(normalizeWatchlistGroups({ Energy: ["XOM"] })).toBeUndefined();
});

test("a ticker moves to one group of the list at a time, a new group goes last, and a group left empty goes", () => {
  const config = configWith({ id: "growth", name: "Growth", groups: [{ name: "Energy", symbols: ["XOM", "CVX"] }] });

  const tech = setWatchlistGroup(config, "growth", ["NVDA", "XOM"], "Tech");
  expect(tech.moved).toEqual(["NVDA", "XOM"]);
  expect(tech.config.watchlists[0]!.groups).toEqual([{ name: "Energy", symbols: ["CVX"] }, { name: "Tech", symbols: ["NVDA", "XOM"] }]);

  // A name is matched in any case and keeps the group's own.
  const back = setWatchlistGroup(tech.config, "growth", ["XOM"], "ENERGY");
  expect(back.group).toBe("Energy");
  expect(back.config.watchlists[0]!.groups).toEqual([{ name: "Energy", symbols: ["CVX", "XOM"] }, { name: "Tech", symbols: ["NVDA"] }]);

  // Already there: nothing moves, and the config is the same one.
  expect(setWatchlistGroup(back.config, "growth", ["CVX"], "energy")).toEqual({ config: back.config, group: "Energy", moved: [] });

  const ungrouped = setWatchlistGroup(back.config, "growth", ["NVDA"], null);
  expect(ungrouped.config.watchlists[0]!.groups).toEqual([{ name: "Energy", symbols: ["CVX", "XOM"] }]);
  // The last ticker out takes the groups away: the list is one without groups again.
  const none = withoutWatchlistGroupSymbols(ungrouped.config, "growth", ["CVX", "XOM"]);
  expect(none.watchlists[0]).toEqual({ id: "growth", name: "Growth" });

  expect(() => setWatchlistGroup(config, "growth", ["NVDA"], " ungrouped ")).toThrow("name the group something else");
  expect(() => setWatchlistGroup(config, "growth", ["NVDA"], "x".repeat(41))).toThrow("at most 40 characters");
});

test("sections keep the order given within each group, groups in the list's order, then the rest; none when nothing is grouped", () => {
  const groups = [{ name: "Tech", symbols: ["NVDA", "AAPL"] }, { name: "Funds", symbols: ["VTSAX"] }, { name: "Energy", symbols: ["XOM"] }];
  // Sorted by the table: AAPL above NVDA whatever order the group lists them in.
  const sorted = ["SPY", "AAPL", "VTSAX", "NVDA", "QQQ"];
  expect(sectionWatchlistItems(groups, sorted, (symbol) => symbol)).toEqual([
    { name: "Tech", items: ["AAPL", "NVDA"] },
    { name: "Funds", items: ["VTSAX"] },
    { name: null, items: ["SPY", "QQQ"] },
  ]);
  expect(sectionWatchlistItems(groups, ["SPY", "QQQ"], (symbol) => symbol)).toBeNull();
  expect(sectionWatchlistItems([], sorted, (symbol) => symbol)).toBeNull();
});

test("a row merged into its listing's key keeps its group there, unless the listing already has one", () => {
  const config = configWith({ id: "banks", name: "Banks", groups: [
    { name: "Turkey", symbols: ["GARAN.IS", "AKBNK.IS"] },
    { name: "Watch", symbols: ["AKBNK:BIST"] },
  ] });
  const moved = moveWatchlistGroupSymbols(config, new Map([["GARAN.IS", "GARAN:BIST"], ["AKBNK.IS", "AKBNK:BIST"]]));
  expect(moved.watchlists[0]!.groups).toEqual([
    { name: "Turkey", symbols: ["GARAN:BIST"] },
    { name: "Watch", symbols: ["AKBNK:BIST"] },
  ]);
  expect(moveWatchlistGroupSymbols(config, new Map([["SHOP.TO", "SHOP:TSX"]]))).toBe(config);
});

test("a loaded ticker that left its list some other way leaves its group; a symbol with no loaded row keeps its group", () => {
  const config = {
    ...createDefaultConfig("/unused-watchlist-groups"),
    watchlists: [
      { id: "growth", name: "Growth", groups: [{ name: "Energy", symbols: ["XOM", "CVX"] }, { name: "Tech", symbols: ["NVDA"] }] },
      { id: "funds", name: "Funds", groups: [{ name: "Index", symbols: ["VTSAX", "FXAIX"] }] },
    ],
  };
  // NVDA is loaded and was taken off Growth while it stays on another list: it leaves Tech.
  // CVX has no loaded row (a pull not yet written, or a row that did not read): it stays in Energy.
  const tickers = [createTestTicker("XOM", "Exxon", { watchlists: ["growth"] }), createTestTicker("NVDA", "NVIDIA", { watchlists: ["other"] })];
  expect(withoutStaleWatchlistGroupSymbols(config, tickers).watchlists).toEqual([
    { id: "growth", name: "Growth", groups: [{ name: "Energy", symbols: ["XOM", "CVX"] }] },
    { id: "funds", name: "Funds", groups: [{ name: "Index", symbols: ["VTSAX", "FXAIX"] }] },
  ]);
  // FXAIX is missing from the store while Funds has another loaded ticker: still kept, and nothing changes.
  const funds = [createTestTicker("VTSAX", "Vanguard", { watchlists: ["funds"] })];
  expect(withoutStaleWatchlistGroupSymbols(config, funds)).toBe(config);
});
