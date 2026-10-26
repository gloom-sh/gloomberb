import { expect, test } from "bun:test";
import type { ScreenCheckPayload, ScreenDefinition } from "../../../api-client/equity-screener";
import { fetchScreenCheck } from "./client";
import { equityScreenerHeadless } from "./headless";
import { checkRows, screenCheckTicker, validateScreenCheck } from "./screen-check";
import { screenFixture } from "./test-fixture";

const definition: ScreenDefinition = {
  version: 1, currency: "USD", sort: { field: "marketCap", direction: "desc" },
  criteria: [{ field: "trailingPE", op: "lte", value: 25 }, { field: "industry", op: "missing" }],
};
function fixture(): ScreenCheckPayload {
  return {
    version: 1, status: "partial", symbol: "NVDA", definition, snapshot: screenFixture().snapshot!,
    matches: false,
    row: { symbol: "NVDA", exchange: "NASDAQ", name: "NVIDIA", currency: "USD", sector: "Technology", industry: null },
    criteria: [
      { criterion: { field: "currency", op: "in", value: ["USD"] }, implicit: true, value: "USD", passes: true, state: "available", unit: "", asOf: null, observedAt: null, reason: null },
      { criterion: definition.criteria[0]!, implicit: false, value: 25.0001, passes: false, state: "stale", unit: "x", asOf: "2026-09-21", observedAt: null, reason: "Observation is stale" },
      { criterion: definition.criteria[1]!, implicit: false, value: null, passes: true, state: "missing", unit: "", asOf: null, observedAt: null, reason: "No stored value" },
    ], warnings: [],
  };
}

test("checks are pinned to the requested definition, listing and snapshot, preserving server decisions", async () => {
  const requests: Array<{ path: string; body: unknown; signal: AbortSignal | null | undefined }> = [];
  const controller = new AbortController();
  const client = { equityScreener: async (path: string, init: RequestInit) => {
    requests.push({ path, body: JSON.parse(String(init.body)), signal: init.signal });
    return fixture();
  } };
  const data = await fetchScreenCheck(definition, "nvda:xnas", "one", controller.signal, client as never);
  expect(requests).toEqual([{ path: "check", body: { ...definition, symbol: "NVDA", exchange: "NASDAQ", snapshotId: "one" }, signal: controller.signal }]);
  expect(checkRows(data).map(({ value, result }) => ({ value, result }))).toEqual([
    { value: "USD", result: "Pass" }, { value: "25.0001 x", result: "Fail" }, { value: "Missing", result: "Pass" },
  ]);
  for (const mutate of [
    (value: ScreenCheckPayload) => { value.snapshot.id = "another"; },
    (value: ScreenCheckPayload) => { value.definition.currency = "CAD"; },
    (value: ScreenCheckPayload) => { value.row!.exchange = "NYSE"; },
    (value: ScreenCheckPayload) => { value.criteria.shift(); },
    (value: ScreenCheckPayload) => { value.criteria[1]!.value = Infinity; },
    (value: ScreenCheckPayload) => { value.criteria[1]!.passes = null; },
    (value: ScreenCheckPayload) => { value.matches = true; },
  ]) {
    const bad = structuredClone(fixture());
    mutate(bad);
    expect(() => validateScreenCheck(bad, definition, { symbol: "NVDA", exchange: "NASDAQ" }, "one")).toThrow();
  }
  expect(() => screenCheckTicker("NVDA MSFT")).toThrow("Enter one ticker");
  data.criteria[1]!.value = 1.0000000000000002;
  expect(checkRows(data)[1]!.value).toBe("1.0000000000000002 x");
  const alternate = fixture();
  alternate.symbol = "BRK-B";
  alternate.row!.symbol = "BRK.B";
  expect(validateScreenCheck(alternate, definition, { symbol: "BRK-B" }).row!.symbol).toBe("BRK.B");
});

test("a ticker outside the universe is not evaluated, while a missing value can pass missing", () => {
  const data = fixture();
  data.status = "not-covered";
  data.matches = null;
  data.row = null;
  data.criteria = data.criteria.map((entry) => ({ ...entry, value: null, passes: null, state: "not-covered" }));
  expect(checkRows(validateScreenCheck(data, definition, { symbol: "NVDA" })).every((row) => row.result === "Not evaluated")).toBe(true);
  data.criteria[0]!.passes = false;
  expect(() => validateScreenCheck(data, definition, { symbol: "NVDA" })).toThrow();
});

test("fn checks saved or explicit criteria without loading matching rows or overlaying live quotes", async () => {
  const calls: string[] = [];
  const apiClient = { equityScreener: async (path: string) => {
    calls.push(path);
    if (path === "saved") return { screens: [{ id: "growth", name: "Growth", revision: 1, definition }] };
    if (path === "check") return fixture();
    throw new Error(`Unexpected request: ${path}`);
  } };
  const ctx = { apiClient, marketData: { getQuotesBatch: () => { throw new Error("Live quote must not change a check"); } } };
  const result = await equityScreenerHeadless.load({ options: { check: "NVDA", saved: "Growth" } } as never, ctx as never);
  expect(calls).toEqual(["saved", "check"]);
  expect(result.metadata).toMatchObject({ matches: false, savedScreen: "Growth", criteria: fixture().criteria });
  expect(result.sections![0]!.rows![1]).toMatchObject({ value: "25.0001 x", result: "Fail", state: "stale" });
  await expect(equityScreenerHeadless.load({ options: { check: "NVDA", saved: "Growth", definition: JSON.stringify(definition) } } as never, ctx as never))
    .rejects.toThrow("Choose --saved or --definition");
  calls.length = 0;
  await expect(equityScreenerHeadless.load({ options: { check: "NVDA", saved: "Unknown" } } as never, ctx as never))
    .rejects.toThrow("was not found");
  expect(calls).toEqual(["saved"]);
});

test("a screen without any restrictions still reports its verdict", async () => {
  const data = fixture();
  data.definition = { ...definition, currency: null, criteria: [], sort: { field: "symbol", direction: "asc" } };
  data.criteria = [];
  data.matches = true;
  data.status = "available";
  const result = await equityScreenerHeadless.load({ options: { check: "NVDA", definition: JSON.stringify(data.definition) } } as never,
    { apiClient: { equityScreener: async () => data } } as never);
  expect(result.sections![0]!.entries).toEqual([{ label: "Result", value: "Passes all criteria" }]);
});
