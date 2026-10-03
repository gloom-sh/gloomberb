import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { cachedSupplyChain, fetchSupplyChain, loadSupplyChain, supplyChainCache, validateSupplyChain } from "./client";
import { flowBands, percentage, sortRows } from "./model";
import { entity, supplyPayload, supplyRow } from "./test-fixture";

afterEach(() => { setCloudApiFetchTransport(null); supplyChainCache.reset(); });

test("untrusted disclosure rows cannot fabricate units, clickable schemes or anonymous tickers", () => {
  for (const row of [supplyRow("x", { pctBasis: null }), supplyRow("x", { usd: 1, usdBasis: null }),
    supplyRow("x", { quote: " " }), supplyRow("x", { pctOfRevenue: Number.NaN }), supplyRow("x", { pctOfRevenue: 101 }),
    supplyRow("x", { filedDate: "2026-02-30" }), supplyRow("x", { confidence: 2 }), supplyRow("x", { filingUrl: "javascript:alert(1)" }),
    supplyRow("x", { counterparty: { ...entity("anonymous"), anonymous: true } })]) {
    expect(() => validateSupplyChain(supplyPayload({ says: [row] }))).toThrow("unreadable");
  }
  expect(validateSupplyChain(supplyPayload()).says[0]?.pctOfRevenue).toBe(22);
});

test("cache partitions accounts and entitlements, preserves data on outage, refuses revoked access", async () => {
  supplyChainCache.attach(new MemoryPluginPersistence());
  let response = supplyPayload();
  let code = 200;
  setCloudApiFetchTransport(async () => Response.json(code === 200 ? response : { message: "Denied" }, { status: code }));
  await loadSupplyChain("FOCUS", "alice:full");
  expect(cachedSupplyChain("FOCUS", "alice:preview")).toBeNull();
  expect(cachedSupplyChain("FOCUS", "bob:full")).toBeNull();
  code = 502;
  expect((await loadSupplyChain("FOCUS", "alice:full", true)).stale).toBe(true);
  code = 403;
  await expect(loadSupplyChain("FOCUS", "alice:full", true)).rejects.toThrow();
  code = 200;
  response = supplyPayload({ says: [], names: [], totalRows: 0, status: "unavailable" });
  expect((await loadSupplyChain("FOCUS", "alice:full", true)).payload.says).toHaveLength(0);
});

test("missing route has an unavailable state, other request errors stay actionable", async () => {
  await expect(fetchSupplyChain("X", { getCloudSupplyChain: async () => { throw new ApiRequestError("missing", 404); } })).rejects.toThrow("not available yet");
  await expect(fetchSupplyChain("X", { getCloudSupplyChain: async () => { throw new ApiRequestError("offline", 502); } })).rejects.toThrow("offline");
});

test("70 relationships remain bounded and every band page is reachable without inventing weights", () => {
  const rows = Array.from({ length: 70 }, (_, i) => supplyRow(`company-${i}`, { pctOfRevenue: i + 1 }));
  const found = new Set<string>();
  for (let page = 0; page < 14; page++) {
    const band = flowBands(rows, 6, { customers: page }).customers;
    expect(band).toHaveLength(6);
    expect(band.at(-1)?.more).toBe(65);
    for (const node of band) if (node.row) found.add(node.id);
  }
  expect(found.size).toBe(70);
  const unknown = flowBands([supplyRow("unknown", { pctOfRevenue: null, pctBasis: null })], 6).customers[0]!;
  expect(unknown.weight).toBe(0.035);
  const mixed = flowBands([supplyRow("scoped", { pctOfRevenue: 99, pctScope: "Segment" }), supplyRow("revenue", { pctOfRevenue: 80 }), supplyRow("receivables", { pctOfRevenue: 99, pctBasis: "receivables" })], 6).customers;
  expect(mixed.find((node) => node.id === "receivables")?.weight).toBe(0.035);
  expect(mixed.find((node) => node.id === "scoped")?.weight).toBe(0.035);
});

test("flow keeps the latest counterparty role once and does not total reverse concentrations", () => {
  const latest = supplyRow("latest", { counterparty: entity("same"), pctOfRevenue: 80 });
  const old = supplyRow("old", { counterparty: entity("same"), asOf: "2025-01-31", pctOfRevenue: 10 });
  expect(flowBands([old, latest], 6).customers.map((node) => node.id)).toEqual(["latest"]);
  const reverse = supplyRow("reverse", { role: "supplier", direction: "in", reportingEntity: entity("CRUS"), pctOfRevenue: 91 });
  expect(percentage(reverse)).toBe("91% revenue");
  expect(flowBands([reverse], 6).suppliers[0]?.weight).toBe(0.035);
  const reverseCustomer = supplyRow("buyer", { reportingEntity: entity("INGM"), pctOfRevenue: 21 });
  expect(flowBands([reverseCustomer], 6, {}, "AAPL").customers[0]?.weight).toBe(0.035);
  for (const direction of ["asc", "desc"] as const) expect(sortRows([latest, supplyRow("missing", { pctOfRevenue: null })], { column: "pct", direction }).at(-1)?.id).toBe("missing");
});
