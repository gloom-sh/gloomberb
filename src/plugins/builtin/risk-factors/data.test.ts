import { afterEach, expect, test } from "bun:test";
import type { CloudRiskReportListPayload } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { IssuerListingParams } from "../../../api-client/paths";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachRiskFactorsPersistence, resetRiskFactorsPersistence, loadRiskReportsWithClient, loadRiskReportWithClient } from "./data";
import { list, report } from "./test-fixtures";

afterEach(resetRiskFactorsPersistence);

const options = { sourceKey: "risk-factors", schemaVersion: 1 };

function client() {
  return {
    getRiskReports: async (_ticker: string, _listing?: IssuerListingParams): Promise<CloudRiskReportListPayload> => list([2026]),
    getRiskReport: async (_ticker: string, year: number) => report(year),
  };
}

test("failed forced discovery retains its original timestamp and retries on reopen before normal cache TTL", async () => {
  const store = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(store);
  store.seedResource("reports", "ACME", list([2025]), options);
  const fetchedAt = store.getResource("reports", "ACME", options)!.fetchedAt;
  const api = client();
  let calls = 0;
  let unavailable = true;
  api.getRiskReports = async () => {
    calls++;
    if (unavailable) throw new ApiRequestError("Discovery unavailable", 503);
    return list([2026, 2025]);
  };

  const stale = await loadRiskReportsWithClient(api, "ACME", { force: true });
  expect(stale).toMatchObject({ fetchedAt, stale: true, refreshError: "Discovery unavailable", errorStatus: 503 });
  expect((await loadRiskReportsWithClient(api, "ACME")).stale).toBe(true);
  expect(calls).toBe(2);

  unavailable = false;
  expect((await loadRiskReportsWithClient(api, "ACME")).reports[0]?.reportYear).toBe(2026);
  expect((await loadRiskReportsWithClient(api, "ACME")).stale).toBe(false);
  expect(calls).toBe(3);
});

for (const status of [401, 403, 404]) {
  test(`report ${status} cannot fall back to cached content`, async () => {
    const store = new MemoryPluginPersistence();
    attachRiskFactorsPersistence(store);
    store.seedResource("report", "ACME:2025", report(2025), { ...options, stale: true });
    const api = client();
    api.getRiskReport = async () => { throw new ApiRequestError("Report unavailable", status); };

    await expect(loadRiskReportWithClient(api, "ACME", 2025)).rejects.toMatchObject({ status });
    expect(store.getResource("report", "ACME:2025", { ...options, allowExpired: true })).toBeNull();
  });
}

test("a list 404 is an empty cached list", async () => {
  const store = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(store);
  const api = client();
  let calls = 0;
  api.getRiskReports = async () => {
    calls++;
    throw new ApiRequestError("No risk factor reports for this ticker", 404);
  };

  await expect(loadRiskReportsWithClient(api, "ACME")).resolves.toMatchObject({ reports: [], stale: false });
  await loadRiskReportsWithClient(api, "ACME");
  expect(calls).toBe(1);
  expect(store.getResource("reports", "ACME", options)?.value).toMatchObject({ reports: [] });
});

test("transient historical refresh retains immutable source dates and expired content", async () => {
  const store = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(store);
  store.seedResource("report", "ACME:2025", report(2025), { ...options, stale: true, expired: true });
  const before = store.getResource("report", "ACME:2025", { ...options, allowExpired: true })!;
  const api = client();
  api.getRiskReport = async () => { throw new ApiRequestError("Temporary outage", 503); };

  const result = await loadRiskReportWithClient(api, "ACME", 2025);
  expect(result).toMatchObject({
    reportYear: 2025,
    filedAt: report(2025).filedAt,
    updatedAt: report(2025).updatedAt,
    docUrl: report(2025).docUrl,
    fetchedAt: before.fetchedAt,
    stale: true,
    refreshError: "Temporary outage",
  });
});

test("late discovery cannot rewind forced refresh persistence", async () => {
  const store = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(store);
  const old = Promise.withResolvers<CloudRiskReportListPayload>();
  const api = client();
  let calls = 0;
  api.getRiskReports = () => ++calls === 1 ? old.promise : Promise.resolve(list([2026, 2025]));

  const first = loadRiskReportsWithClient(api, "ACME");
  expect(loadRiskReportsWithClient(api, "ACME")).toBe(first);
  await loadRiskReportsWithClient(api, "ACME", { force: true });
  old.resolve(list([2025]));
  await first;

  expect((await loadRiskReportsWithClient(api, "ACME")).reports.map((entry) => entry.reportYear)).toEqual([2026, 2025]);
  expect(calls).toBe(2);
});

test("a request from the previous persistence lifetime cannot write into its replacement", async () => {
  const firstStore = new MemoryPluginPersistence();
  const nextStore = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(firstStore);
  const pending = Promise.withResolvers<CloudRiskReportListPayload>();
  const api = client();
  api.getRiskReports = () => pending.promise;

  const first = loadRiskReportsWithClient(api, "ACME");
  await Promise.resolve();
  resetRiskFactorsPersistence();
  attachRiskFactorsPersistence(nextStore);
  pending.resolve(list([2025]));
  await first;

  expect(firstStore.getResource("reports", "ACME", options)).toBeNull();
  expect(nextStore.getResource("reports", "ACME", options)).toBeNull();
});

test("a report response for another ticker or year cannot be cached under the requested filing", async () => {
  const store = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(store);
  const api = client();
  api.getRiskReport = async () => report(2026);

  await expect(loadRiskReportWithClient(api, "ACME", 2025)).rejects.toThrow("does not match ACME 2025");
  expect(store.getResource("report", "ACME:2025", options)).toBeNull();
  api.getRiskReport = async () => ({ ...report(2025), ticker: "OTHER" });
  await expect(loadRiskReportWithClient(api, "ACME", 2025)).rejects.toThrow("does not match ACME 2025");

  // The server spells share classes the SEC way; BRK.B and BRK-B are one filer.
  api.getRiskReport = async () => ({ ...report(2025), ticker: "BRK-B" });
  await expect(loadRiskReportWithClient(api, "BRK.B", 2025)).resolves.toMatchObject({ ticker: "BRK-B" });
});

test("SAN in Paris never shares a list or report with SAN in New York", async () => {
  const store = new MemoryPluginPersistence();
  attachRiskFactorsPersistence(store);
  const requests: Array<[string, IssuerListingParams | undefined]> = [];
  const paris = { exchange: "EPA", name: "Sanofi" };
  const api = client();
  api.getRiskReports = async (ticker: string, listing?: IssuerListingParams) => {
    requests.push([ticker, listing]);
    return list(listing ? [2025] : [2026]);
  };

  expect((await loadRiskReportsWithClient(api, "SAN")).reports.map((entry) => entry.reportYear)).toEqual([2026]);
  expect((await loadRiskReportsWithClient(api, "SAN", { listing: paris })).reports.map((entry) => entry.reportYear)).toEqual([2025]);
  // The key's own venue, in any spelling, is the same listing and reads the same entry.
  expect((await loadRiskReportsWithClient(api, "SAN:XPAR")).reports.map((entry) => entry.reportYear)).toEqual([2025]);
  expect(requests).toEqual([["SAN", undefined], ["SAN", paris]]);
  expect(store.getResource("reports", "SAN:EPA", options)).not.toBeNull();

  // A listing abroad reads its registrant's report, filed under that registrant's US ticker.
  api.getRiskReport = async (_ticker: string, year: number) => ({ ...report(year), ticker: "SNY" });
  await expect(loadRiskReportWithClient(api, "SAN", 2025, { listing: paris })).resolves.toMatchObject({ ticker: "SNY" });
  expect(store.getResource("report", "SAN:EPA:2025", options)).not.toBeNull();
  await expect(loadRiskReportWithClient(api, "SAN", 2025)).rejects.toThrow("does not match SAN 2025");
});
