import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { cachedSupplyChain, fetchSupplyChain, loadSupplyChain, supplyChainCache, validateSupplyChain } from "./client";
import { counterpartyLabel, counterpartyName, disclosedValue, flowBands, percentage, shareParts, sortRows } from "./model";
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

test("native amounts retain their disclosed currency and scale without cross-currency comparisons", () => {
  const yen = supplyRow("yen", { nativeAmount: 368_079, nativeCurrency: "JPY", nativeScale: 1_000_000, jurisdiction: "JP", quoteLanguage: "ja", quoteGloss: "Samsung Electronics represented 15.1% of revenue." });
  expect(disclosedValue(validateSupplyChain(supplyPayload({ says: [yen] })).says[0]!)).toBe("368,079 JPY million");
  const plainYen = supplyRow("plain-yen", { nativeAmount: 400_000_000_000, nativeCurrency: "JPY", nativeScale: 1 });
  const won = supplyRow("won", { nativeAmount: 1, nativeCurrency: "KRW", nativeScale: 1_000 });
  const usd = supplyRow("usd", { usd: 5_000_000, usdBasis: "disclosed" });
  expect(sortRows([won, yen, plainYen, usd], { column: "usd", direction: "desc" }).map((row) => row.id)).toEqual(["plain-yen", "yen", "won", "usd"]);
  expect(disclosedValue(supplyRow("zero", { nativeAmount: 0, nativeCurrency: "TWD", nativeScale: 1_000 }))).toBe("0 TWD thousand");
  expect(flowBands([supplyRow("native-supplier", { ...yen, role: "supplier", pctOfRevenue: null, pctBasis: null })], 6).suppliers[0]?.weight).toBeNull();
  for (const fields of [{ nativeCurrency: null }, { nativeCurrency: "yen" }, { nativeScale: 0 }, { nativeScale: Number.POSITIVE_INFINITY }, { nativeAmount: -1 }, { nativeAmount: 1e308, nativeScale: 1e308 }, { jurisdiction: "Japan" }, { quoteGloss: 42 }, { entityScope: "invented" }]) {
    expect(() => validateSupplyChain(supplyPayload({ says: [{ ...yen, ...fields } as typeof yen] }))).toThrow("unreadable");
  }
  expect(disclosedValue(validateSupplyChain(supplyPayload()).says[0]!)).toBe("--");
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
  expect(unknown.weight).toBeNull();
  const mixed = flowBands([supplyRow("scoped", { pctOfRevenue: 99, pctScope: "Segment" }), supplyRow("revenue", { pctOfRevenue: 80 }), supplyRow("receivables", { pctOfRevenue: 99, pctBasis: "receivables" })], 6).customers;
  expect(mixed.find((node) => node.id === "receivables")?.weight).toBeNull();
  expect(mixed.find((node) => node.id === "scoped")?.weight).toBeNull();
});

test("flow keeps the latest counterparty role once and does not total reverse concentrations", () => {
  const latest = supplyRow("latest", { counterparty: entity("same"), pctOfRevenue: 80 });
  const old = supplyRow("old", { counterparty: entity("same"), asOf: "2025-01-31", pctOfRevenue: 10 });
  expect(flowBands([old, latest], 6).customers.map((node) => node.id)).toEqual(["latest"]);
  const reverse = supplyRow("reverse", { role: "supplier", direction: "in", reportingEntity: entity("CRUS"), pctOfRevenue: 91 });
  expect(percentage(reverse)).toBe("91% revenue");
  expect(flowBands([reverse], 6).suppliers[0]?.weight).toBeNull();
  const reverseCustomer = supplyRow("buyer", { reportingEntity: entity("INGM"), pctOfRevenue: 21 });
  expect(flowBands([reverseCustomer], 6, {}, "AAPL").customers[0]?.weight).toBeNull();
  for (const direction of ["asc", "desc"] as const) expect(sortRows([latest, supplyRow("missing", { pctOfRevenue: null })], { column: "pct", direction }).at(-1)?.id).toBe("missing");
});

test("aggregate concentrations stay labeled table facts and never affect flow membership or scale", () => {
  const group = supplyRow("group", { counterparty: { ...entity("group", "United States And Europe Based End Customers"), aggregate: true }, pctOfRevenue: 76 });
  const payload = supplyPayload({ says: [group, supplyRow("one"), supplyRow("two", { pctOfRevenue: 14 })], totalRows: 3 });
  payload.counts.says.customer = 3;
  expect(validateSupplyChain(payload).says).toHaveLength(3);
  expect(counterpartyName(group)).toStartWith("Group: ");
  const nodes = flowBands(payload.says, 2, {}, "FOCUS").customers;
  expect(nodes.map((node) => node.id)).toEqual(["one", "two"]);
  expect(nodes.map((node) => node.weight)).toEqual([1, 14 / 22]);
  const legacy = JSON.parse(JSON.stringify(payload));
  delete legacy.says[1].counterparty.aggregate;
  expect(validateSupplyChain(legacy).says[1]?.counterparty.aggregate).toBe(false);
  legacy.says[1].counterparty.aggregate = "yes";
  expect(() => validateSupplyChain(legacy)).toThrow("unreadable");
});

test("revenue ribbons share exact scope and period while dollar scales remain stable across pages", () => {
  const scoped = (id: string, pct: number) => supplyRow(id, { pctScope: "Compute And Networking Segment", pctOfRevenue: pct });
  const nodes = flowBands([scoped("one", 22), scoped("two", 14), supplyRow("other-scope", { pctScope: "Gaming", pctOfRevenue: 60 }),
    supplyRow("old-period", { period: "2025-01-31", pctScope: "Compute And Networking Segment", pctOfRevenue: 95 })], 6, {}, "FOCUS").customers;
  expect(nodes.find((node) => node.id === "one")?.weight).toBe(1);
  expect(nodes.find((node) => node.id === "two")?.weight).toBe(14 / 22);
  expect(nodes.find((node) => node.id === "other-scope")?.weight).toBeNull();
  expect(nodes.find((node) => node.id === "old-period")?.weight).toBeNull();
  const dollars = [149_000_000, 3_320_000, 1_000_000].map((usd, i) => supplyRow(`dollar-${i}`, { role: "supplier", usd, usdBasis: "disclosed", pctOfRevenue: null, pctBasis: null }));
  dollars.unshift(supplyRow("unknown-dollars", { role: "supplier", pctOfRevenue: 99 }));
  expect(flowBands(dollars, 2, { suppliers: 0 }).suppliers[0]?.id).toBe("dollar-0");
  expect(flowBands(dollars, 2, { suppliers: 0 }).suppliers[0]?.weight).toBe(1);
  expect(flowBands(dollars, 2, { suppliers: 1 }).suppliers[0]?.weight).toBe(3_320_000 / 149_000_000);
});

test("a share always names its denominator: the reporting company's revenue in reverse, the scope, or receivables", () => {
  const reverse = supplyRow("crus", { role: "supplier", direction: "in", reportingEntity: entity("CRUS"), pctOfRevenue: 91 });
  expect(shareParts(reverse, "AAPL")).toEqual({ value: "91%", basis: "of CRUS revenue" });
  expect(shareParts(supplyRow("own", { pctOfRevenue: 22.04 }), "FOCUS")).toEqual({ value: "22%", basis: "of FY revenue" });
  expect(shareParts(supplyRow("seg", { pctOfRevenue: 14, pctScope: "Compute And Networking Segment" }), "FOCUS")?.basis).toBe("of Compute & Networking revenue");
  expect(shareParts(supplyRow("ar", { pctOfRevenue: 47, pctBasis: "receivables", pctScope: "Vendor non-trade receivables" }), "FOCUS")?.basis).toBe("of vendor non-trade receivables");
  expect(shareParts(supplyRow("none", { pctOfRevenue: null, pctBasis: null }), "FOCUS")).toBeNull();
  const group = supplyRow("group", { counterparty: { ...entity("group", "United States And Europe Based End Customers"), aggregate: true, ticker: null } });
  expect(counterpartyLabel(group)).toBe("United States and Europe based end customers");
});
