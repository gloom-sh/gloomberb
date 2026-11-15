import { expect, test } from "bun:test";
import { createTestTicker } from "../../../../test-support/ticker";
import { buildWatchlistTableGroups, toggleCollapsedGroup } from "./groups";

const [xom, nvda, spy, aapl] = ["XOM", "NVDA", "SPY", "AAPL"].map((symbol) => createTestTicker(symbol, symbol));
const watchlist = { id: "growth", groups: [{ name: "Tech", symbols: ["NVDA", "AAPL"] }, { name: "Energy", symbols: ["XOM"] }] };

test("a watchlist's rows sit under its groups in the table's sort, and a group's collapse is this list's alone", () => {
  // Sorted by the table: AAPL above NVDA.
  const sorted = [spy!, aapl!, xom!, nvda!];
  const collapsed = toggleCollapsedGroup(toggleCollapsedGroup([], "growth", "Energy"), "value", "Tech");
  expect(buildWatchlistTableGroups(watchlist, sorted, collapsed)?.map((group) => [group.label, group.tickers.map((ticker) => ticker.metadata.ticker), group.collapsed]))
    .toEqual([["Tech", ["AAPL", "NVDA"], false], ["Energy", ["XOM"], true], ["Ungrouped", ["SPY"], false]]);
  expect(toggleCollapsedGroup(collapsed, "growth", "Energy")).toEqual([{ list: "value", group: "Tech" }]);

  // A list with no row in a group has no sections, as before groups.
  expect(buildWatchlistTableGroups({ id: "plain" }, sorted, [])).toBeUndefined();
  expect(buildWatchlistTableGroups(watchlist, [spy!], [])).toBeUndefined();
});
