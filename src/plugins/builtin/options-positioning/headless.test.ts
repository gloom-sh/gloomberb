import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import type { HeadlessBundleResult } from "../../../types/plugin";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { GammaPayload, OpenInterestPayload } from "./client";
import { optionsPositioningHeadless } from "./headless";

const expiry = (date: string, days: number) => ({
  date, days, callOI: 1_000, putOI: 2_000, putCallRatio: 2, maxPain: 760, callChange: null, putChange: null,
});
const openInterest: OpenInterestPayload = {
  version: 1, symbol: "SPY", underlying: "SPY", oiDate: "2026-10-14", previousOiDate: null, tracked: true,
  spot: 764.1, spotAsOf: "2026-10-16T17:07:26.526Z", delayed: true,
  expiries: [expiry("2026-10-16", 0), expiry("2026-10-30", 14), expiry("2026-11-20", 35)],
  expiry: "2026-10-30", strikes: [{ strike: 760, callOI: 10, putOI: 20, callChange: null, putChange: null, payout: 5 }],
  warnings: [],
};
// Amounts the text rounds to three figures, so an export read back from the text would not add up.
const strikes = [
  { strike: 750, calls: 57.1319180766, puts: 1_139_604.2187, net: 57.1319180766 - 1_139_604.2187 },
  { strike: 765, calls: 2_416_009.5531, puts: 1_207_342.1133, net: 2_416_009.5531 - 1_207_342.1133 },
  { strike: 780, calls: 3_301_877.25, puts: 0, net: 3_301_877.25 },
];
const total = { calls: 5_718_943.94, puts: 2_346_946.33, net: 3_371_997.61 };
const gamma = (scope: string | null, byExpiry?: GammaPayload["byExpiry"]): GammaPayload => ({
  version: 1, symbol: "SPY", underlying: "SPY", oiDate: "2026-10-14", spot: 764.2, spotAsOf: "2026-10-16T17:08:00Z",
  delayed: true, expiry: scope, expiries: [], missing: [], total,
  band: { low: -1e6, high: 4e6, shareLow: 0.25, shareHigh: 0.75 }, flip: 761.5, strikes,
  quotesAsOf: "2026-10-16T17:04:32Z", warnings: [], ...(byExpiry ? { byExpiry } : {}),
});
const byExpiry = [
  { expiry: "2026-10-16", calls: 4e6, puts: 1.5e6, net: 2.5e6 },
  { expiry: "2026-10-30", calls: 1.2e6, puts: 0.6e6, net: 0.6e6 },
  { expiry: "2026-11-20", calls: 518_943.94, puts: 246_946.33, net: 271_997.61 },
];

async function report(options: { expiry?: string; withByExpiry?: boolean }) {
  const definition = optionsPositioningHeadless("gex");
  const args = createTestHeadlessArgs({ symbols: ["SPY"], options: options.expiry ? { expiry: options.expiry } : {} });
  const apiClient = {
    optionsPositioning: async (path: string) => {
      if (path.startsWith("open-interest")) return openInterest;
      const scope = new URLSearchParams(path.split("?")[1]).get("expiry");
      return gamma(scope, options.withByExpiry === false ? undefined : scope ? [byExpiry[1]!] : byExpiry);
    },
  } as never;
  const result = await definition.load(args, createTestHeadlessContext({ apiClient })) as HeadlessBundleResult;
  const freshness = deriveHeadlessFreshness(definition, result);
  const tables = headlessReportTables(definition, result, args, "GEX", freshness, { complete: true, unavailableSymbols: [] });
  return { result, tables, text: renderHeadlessPaneText(definition, result, args, "GEX", freshness), csv: renderReportCsv(tables, freshness) };
}

test("the GEX export adds up, names its unit, and opens with spot and quote times apart from the OI session", async () => {
  const { tables, text, csv } = await report({ expiry: "2026-10-30" });
  const [summary, expiries, , dealer] = tables.tables;

  // Puts export signed and whole, so call + put is net on every row, each naming the unit.
  const column = (name: string) => dealer!.columns.indexOf(name);
  for (const row of dealer!.rows) {
    expect(Number(row[column("Call GEX $")]) + Number(row[column("Put GEX $")])).toBeCloseTo(Number(row[column("Net GEX $")]), 4);
  }
  expect(dealer!.rows[0]![column("Put GEX $")]).toBe(-1_139_604.2187);
  const gexLines = csv.split("# section: Dealer gamma · Oct 30 '26\n")[1]!.split("\n\n")[0]!.split("\n").slice(1);
  expect(gexLines.length).toBe(3);
  expect(gexLines.every((line) => line.includes(",USD per 1% move,"))).toBe(true);

  // One summary block first, in the text and the CSV, dating spot and quotes apart from open interest.
  expect(text.split("\n").slice(2, 6)).toEqual([
    "Summary · Oct 30 '26",
    expect.stringMatching(/^Spot +764\.20 last Fri 16 Oct 17:08 UTC/),
    expect.stringMatching(/^Quotes as of +2026-10-16 17:04 UTC/),
    expect.stringMatching(/^Open interest as of +2026-10-14$/),
  ]);
  expect(csv.split("\n")[0]).toBe("# section: Summary · Oct 30 '26");
  const value = (label: string) => summary!.rows.find((row) => row[0] === label)?.[1];
  expect(value("Spot as of")).toBe("2026-10-16T17:08:00Z");
  expect(value("Quotes as of")).toBe("2026-10-16T17:04:32Z");
  expect(value("Net GEX (USD per 1% move)")).toBe(3_371_997.61);
  expect([value("Call wall"), value("Put wall"), value("Flip")]).toEqual([780, 765, 761.5]);
  expect(text).toMatch(/Dealer range +-1\.00M to \+4\.00M, 25-75% with dealers/);

  // Expiries carry every expiry's net gamma, read from the all-expiries answer, and add up to its net.
  const net = expiries!.columns.indexOf("Net GEX $ (USD per 1% move)");
  const nets = expiries!.rows.map((row) => Number(row[net]));
  expect(nets).toEqual(byExpiry.map((row) => row.net));
  expect(nets.reduce((sum, entry) => sum + entry, 0)).toBeCloseTo(total.net, 4);
});

test("an older server without per-expiry gamma leaves the Net GEX column blank", async () => {
  const { result, tables } = await report({ withByExpiry: false });
  const expiries = tables.tables[1]!;
  // The header names its unit as it does with figures in it, so a script's columns do not move.
  expect(expiries.rows.map((row) => row[expiries.columns.indexOf("Net GEX $ (USD per 1% move)")])).toEqual(["", "", ""]);
  expect(result.errors).toEqual([]);
});
