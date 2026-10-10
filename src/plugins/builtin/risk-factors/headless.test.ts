import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { buildHeadlessFunctionReport } from "../../../cli/pane-functions/headless";
import { blockExternalNetwork } from "../../../test-support/network-guard";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import { attachRiskFactorsPersistence, resetRiskFactorsPersistence } from "./data";
import { riskFactorsHeadless } from "./headless";
import { list, report } from "./test-fixtures";

blockExternalNetwork();

let requests: string[] = [];

afterEach(() => {
  resetRiskFactorsPersistence();
  setCloudApiFetchTransport(null);
  apiClient.dispose();
  requests = [];
});

function transport(respond: (path: string) => Response) {
  setCloudApiFetchTransport((async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    return respond(path);
  }) as typeof fetch);
}

function run(year = "latest", refresh = false) {
  return buildHeadlessFunctionReport(
    {
      headless: riskFactorsHeadless,
      token: "RISK",
      label: "Risk Factors",
      options: { year, refresh },
      instance: { settings: {} },
      capability: { id: "risk-factors" },
    } as never,
    { dataProvider: createTestDataProvider(), config: createDefaultConfig("/tmp/gloomberb-risk-headless-test"), store: { loadTicker: async () => null } } as never,
    "ACME",
  );
}

test("actual RISK report distinguishes a stale latest discovery from an independently valid historical filing", async () => {
  const store = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(store);
  store.seedResource("reports", "ACME", list([2025]), { sourceKey: "risk-factors", schemaVersion: 1, stale: true });
  store.seedResource("report", "ACME:2025", report(2025), { sourceKey: "risk-factors", schemaVersion: 1 });
  transport(() => new Response("Discovery unavailable", { status: 503 }));

  const latest = await run();
  expect(latest.data.complete).toBe(false);
  expect(latest.data.metadata).toMatchObject({
    reportYear: 2025,
    listStale: true,
    filedAt: report(2025).filedAt,
    updatedAt: report(2025).updatedAt,
    docUrl: report(2025).docUrl,
  });
  expect(latest.text).toContain("Discovery unavailable");
  expect(latest.text).toContain("Source 2025 text");

  requests = [];
  const historical = await run("2025");
  expect(historical.data.complete).toBe(true);
  expect(historical.data.metadata).toMatchObject({ requestedYear: "2025", latestDiscoveryChecked: false, listStale: false });
  expect(requests).toEqual([]);
});

test("actual latest RISK export preserves source text, separate analysis and full change provenance", async () => {
  const current = report(2026);
  current.diff = {
    added: [0],
    removed: [{ heading: "Retired source risk", group: "Business", excerpt: "Prior filing text" }],
    reworded: [],
    matched: 0,
    priorRiskCount: 1,
  };
  current.notes.added = [{ index: 0, text: "Model analysis of added risk" }];
  current.notes.removed = [{ index: 0, text: "Model analysis of removed risk" }];
  transport((path) => path.endsWith("/ACME") ? Response.json(list([2025, 2026])) : Response.json(current));

  const result = await run("latest", true);
  expect(result.data.complete).toBe(true);
  expect(result.data.metadata).toMatchObject({
    reportYear: 2026,
    filedAt: current.filedAt,
    updatedAt: current.updatedAt,
    diff: current.diff,
  });
  expect(result.text).toContain("Source 2026 text");
  expect(result.text).toContain("Model analysis of added risk");
  expect(result.text).toContain("Prior filing text");
  expect(result.text).toContain(current.docUrl);
});

test("an explicit missing filing fails without silently selecting a different year", async () => {
  transport((path) => path.endsWith("/2024")
    ? new Response("Requested 2024 report not found", { status: 404 })
    : Response.json(list([2026])));

  await expect(run("2024")).rejects.toThrow("Requested 2024 report not found");
  expect(requests).toEqual(["/cloud/risks/ACME/2024"]);
});

test("empty discovery does not fabricate the current annual report and invalid year input never requests one", async () => {
  transport(() => Response.json(list([])));

  await expect(run()).rejects.toThrow("No 10-K risk reports on file for ACME");
  requests = [];
  await expect(run("2025-26")).rejects.toThrow("four-digit filing year or latest");
  expect(requests).toEqual([]);
});
