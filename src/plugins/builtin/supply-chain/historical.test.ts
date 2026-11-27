import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { SupplyEvidenceItem } from "../../../api-client/supply-chain";
import { supplyGraphQuery } from "../../../api-client/supply-chain-graph";
import { cachedSupplyChain, fetchSupplyChain, loadSupplyChain, loadSupplyChainsAhead, supplyChainCache } from "./client";
import { cachedGraph, fetchSupplyGraph, graphCache, graphOptions, loadGraph, loadGraphsAhead } from "./graph-client";
import { supplyPayload, supplyRow } from "./test-fixture";
import { graphPayload } from "./test-fixture-graph";
import { supplyOptions } from "./trust";

const cutoff = "2026-03-01";
const options = graphOptions({ asOf: cutoff });
const evidence = (id: string, publishedAt: string): SupplyEvidenceItem => ({
  id, tier: 1, claimType: "disclosed", url: "https://www.sec.gov/example", title: "Filing evidence", publisher: "Issuer",
  publishedAt, fetchedAt: "2026-04-01T00:00:00Z", quote: "Original disclosure", quoteRights: "full", textOrigin: "publisher_text",
  quoteLanguage: "en", englishGloss: null, originKey: id, confidence: .95, status: "active", valueKind: null, value: null, valueUnit: null, currency: null,
});
const first = evidence("first", "2026-02-25T12:00:00Z");
const later = evidence("later", "2026-03-02T12:00:00Z");

afterEach(() => { setCloudApiFetchTransport(null); graphCache.reset(); supplyChainCache.reset(); });

test("direct graph and paths require the requested cutoff and reject later corroboration", async () => {
  const data = graphPayload();
  const entry = data.links[0]!.evidence[0]!;
  data.options.asOf = "2026-04-01";
  entry.evidence = [first, later];
  const client = { getCloudSupplyGraph: async () => data, getCloudSupplyPaths: async () => data };
  await expect(fetchSupplyGraph("FOCUS", options, "", client)).rejects.toThrow("requested filing cutoff 2026-03-01");
  data.options.asOf = cutoff;
  await expect(fetchSupplyGraph("FOCUS", options, "3", client)).rejects.toThrow("published after 2026-03-01");
  entry.evidence = [first];
  await expect(fetchSupplyGraph("FOCUS", options, "", client)).resolves.toMatchObject({ options: { asOf: cutoff } });
  delete data.options.asOf;
  await expect(fetchSupplyGraph("FOCUS", options, "", client)).rejects.toThrow("requested filing cutoff 2026-03-01");
});

test("dated table reads check all evidence and reject cached copies under the same cutoff", async () => {
  const table = supplyPayload({ says: [supplyRow("supplier", { evidence: [first, later] })] });
  const validateRead = () => fetchSupplyChain("FOCUS", { getCloudSupplyChain: async () => table }, { asOf: cutoff });
  await expect(validateRead()).rejects.toThrow("published after 2026-03-01");
  const key = `FOCUS:free:${JSON.stringify(supplyOptions())}:false:${cutoff}`;
  await supplyChainCache.load(key, async () => table, { force: true });
  expect(cachedSupplyChain("FOCUS", "free", { asOf: cutoff })).toBeNull();
  await expect(loadSupplyChain("FOCUS", "free", false, { asOf: cutoff })).rejects.toThrow("published after 2026-03-01");
  table.says[0]!.evidence = [first];
  table.says[0]!.lastConfirmedAt = later.publishedAt;
  await expect(validateRead()).rejects.toThrow("published after 2026-03-01");
  table.says[0]!.lastConfirmedAt = first.publishedAt;
  await expect(validateRead()).resolves.toMatchObject({ says: [{ evidence: [first] }] });

  let reads = 0;
  setCloudApiFetchTransport(async () => { reads++; return Response.json({ items: [] }); });
  expect(await loadSupplyChainsAhead(["FOCUS", "SECOND"], "free", true, { asOf: cutoff })).toEqual(new Set());
  expect(reads).toBe(0);
});

test("dated graph batches refuse noncompliant items; preexisting cache cannot bypass the guard", async () => {
  const good = graphPayload();
  good.options.asOf = cutoff;
  const bad = structuredClone(good);
  bad.links[0]!.evidence[0]!.evidence = [first, later];
  setCloudApiFetchTransport(async () => Response.json({ items: [{ symbol: "FOCUS", graph: bad }, { symbol: "SECOND", graph: good }] }));
  const stored = await loadGraphsAhead(["FOCUS", "SECOND"], options, "free", true);
  expect([...stored]).toEqual(["SECOND"]);
  expect(cachedGraph("SECOND", "", options, "free")?.payload.options.asOf).toBe(cutoff);
  expect(cachedGraph("FOCUS", "", options, "free")).toBeNull();
  await graphCache.load(`free:FOCUS::${supplyGraphQuery(options)}`, async () => bad, { force: true });
  expect(cachedGraph("FOCUS", "", options, "free")).toBeNull();
  await expect(loadGraph("FOCUS", "", options, "free")).rejects.toThrow("published after 2026-03-01");
});
