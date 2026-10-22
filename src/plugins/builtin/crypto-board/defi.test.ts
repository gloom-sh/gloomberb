import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { fetchDefiTvl, validateDefiTvl } from "./client";
import { buildDefiColumns, buildDefiRows, defiHistory, defiHistoryStart, defiListAsOf, defiSummaryLine, nextDefiSort, sortDefiRows } from "./defi";
import { defiTvlFixture } from "./test-fixture";

test("the history says the day it starts, counts a range back from its newest day, and keeps a day the source skipped blank", () => {
  const payload = defiTvlFixture();
  // Days before anything was locked are not the start.
  payload.history = { start: "2026-09-17", total: [null, null, ...payload.history!.total, null] };
  expect(defiHistoryStart(payload)).toBe("2026-09-19");

  const all = defiHistory(payload, "ALL")!;
  expect(all.dates.map((day) => day.toISOString().slice(0, 10))).toEqual(["2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]);
  expect(all.values).toEqual([null, null, 90e9, 91e9, null, 92e9, 92.4e9]);
  expect(defiHistory({ ...payload, history: { start: "2026-01-01", total: Array.from({ length: 100 }, (_, day) => day) } }, "1M")!.dates).toHaveLength(31);
  expect(defiHistory({ ...payload, history: { start: "2026-09-23", total: [92.4e9] } }, "ALL")).toBeNull();

  expect(defiSummaryLine(defiTvlFixture())).toBe(
    "Total DeFi TVL 92.40B · 7D +2.01B (+2.22%) · 30D -1.06B (-1.13%) · as of 2026-09-23 · DefiLlama, daily since 2026-09-19",
  );
  // A chain's figures are the day's; a protocol's are the source's latest read.
  expect(defiListAsOf(payload, "chain")).toBe("2026-09-23");
  expect(defiListAsOf(payload, "protocol")).toBe("2026-09-22 16:17 UTC");
});

test("a list keeps its rows across renders and sorts a missing change last either way", () => {
  const payload = defiTvlFixture();
  const rows = buildDefiRows(payload, "protocol");
  expect(buildDefiRows(payload, "protocol")).toBe(rows);
  expect(rows.map((row) => [row.rank, row.name, row.share, row.chains])).toEqual([[1, "Aave", null, 18], [2, "Lido", null, 2]]);
  expect(buildDefiRows(payload, "chain").map((row) => [row.name, row.detail, row.share])).toEqual([["Ethereum", "ETH", 59.96], ["Solana", "SOL", 9.85]]);

  const byChange = nextDefiSort({ columnId: null, direction: "asc" }, "change30dPercent");
  expect(byChange.direction).toBe("desc");
  expect(sortDefiRows(rows, byChange).map((row) => row.name)).toEqual(["Lido", "Aave"]);
  expect(sortDefiRows(rows, { ...byChange, direction: "asc" }).map((row) => row.name)).toEqual(["Lido", "Aave"]);
});

test("a narrow pane drops the optional columns in order and keeps name, TVL, 7D% and a chain's share", () => {
  const ids = (width: number, list: "protocol" | "chain") => buildDefiColumns(width, list).map((column) => column.id);
  expect(ids(200, "protocol")).toEqual(["rank", "name", "detail", "tvl", "change1dPercent", "change7d", "change7dPercent", "change30d", "change30dPercent", "chains"]);
  expect(ids(90, "protocol")).toEqual(["rank", "name", "detail", "tvl", "change7d", "change7dPercent", "change30d", "change30dPercent"]);
  expect(ids(72, "protocol")).toEqual(["rank", "name", "detail", "tvl", "change7dPercent", "change30dPercent"]);
  expect(ids(73, "chain")).toEqual(["rank", "name", "detail", "tvl", "change7dPercent", "change30dPercent", "share"]);
  expect(ids(20, "protocol")).toEqual(["rank", "name", "tvl", "change7dPercent"]);
  expect(ids(20, "chain")).toEqual(["rank", "name", "tvl", "change7dPercent", "share"]);
  expect(buildDefiColumns(200, "chain").find((column) => column.id === "name")!.width).toBe(26);
});

test("the Cloud boundary rejects a malformed board and names DeFi TVL when the endpoint fails", async () => {
  expect(validateDefiTvl(defiTvlFixture()).history!.total[2]).toBeNull();
  const mutations = [
    (copy: ReturnType<typeof defiTvlFixture>) => { (copy.protocols[0] as { tvl: unknown }).tvl = "17.88B"; },
    (copy: ReturnType<typeof defiTvlFixture>) => { copy.chains[0]!.tvl = -1; },
    (copy: ReturnType<typeof defiTvlFixture>) => { copy.history!.total[0] = -1; },
    (copy: ReturnType<typeof defiTvlFixture>) => { (copy as { asOf: unknown }).asOf = "Sep 23"; },
    (copy: ReturnType<typeof defiTvlFixture>) => { (copy.total as { tvl: unknown }).tvl = null; },
  ];
  for (const mutate of mutations) {
    const copy = defiTvlFixture();
    mutate(copy);
    expect(() => validateDefiTvl(copy)).toThrow("invalid DeFi TVL");
  }
  // An empty board, as the server answers before its first read, is valid.
  expect(() => validateDefiTvl({ ...defiTvlFixture(), status: "unavailable", total: null, protocols: [], chains: [], history: null, asOf: null })).not.toThrow();

  await expect(fetchDefiTvl({ getCloudDefiTvl: async () => { throw new ApiRequestError("Not found", 404); } })).rejects.toThrow(/DeFi TVL.*not available/);
});
