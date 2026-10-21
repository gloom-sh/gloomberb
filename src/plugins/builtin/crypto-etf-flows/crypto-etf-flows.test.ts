import { describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CryptoEtfFlowDay, CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs, HeadlessRowsResult } from "../../../types/plugin";
import { fetchCryptoEtfFlows, validateCryptoEtfFlows } from "./client";
import { cryptoEtfFlowsHeadless } from "./headless";
import { cryptoEtfFlowSummary, cumulativeFlows, daysInRange, formatFlow, formatFlowAmount } from "./model";

const day = (date: string, flows: Record<string, number | null>, total: number | null, pending: string[] = []): CryptoEtfFlowDay =>
  ({ date, flows, total, pending });

function payload(days: CryptoEtfFlowDay[] = [
  day("2026-10-20", { IBIT: null, FBTC: 3.6, GBTC: -10.3 }, -6.7, ["IBIT"]),
  day("2026-10-19", { IBIT: 665.2, FBTC: -83.6, GBTC: -54.9 }, 526.7),
  day("2026-10-16", { IBIT: -71.8, FBTC: -10.6, GBTC: 0 }, -82.4),
]): CryptoEtfFlowsPayload {
  return {
    asset: "BTC",
    unit: "USD millions",
    funds: [
      { ticker: "IBIT", name: "iShares Bitcoin Trust ETF", issuer: "iShares (BlackRock)" },
      { ticker: "FBTC", name: "Fidelity Wise Origin Bitcoin Fund", issuer: "Fidelity" },
      { ticker: "GBTC", name: null, issuer: null },
    ],
    days,
    asOf: days[0]?.date ?? "2026-10-20",
    source: { publisher: "Farside Investors", url: "https://farside.co.uk/bitcoin-etf-flow-all-data/" },
    fetchedAt: "2026-10-21T02:09:34.743Z",
    stale: false,
  };
}

describe("crypto ETF flows payload", () => {
  test("a payload whose days, funds or asset do not hold together is not drawn", () => {
    expect(validateCryptoEtfFlows(payload(), "BTC").days).toHaveLength(3);
    const broken: Array<[string, CryptoEtfFlowsPayload]> = [
      ["other asset", { ...payload(), asset: "ETH" }],
      ["days out of order", payload([day("2026-10-16", {}, 1), day("2026-10-19", {}, 2)])],
      ["a fund not listed", payload([day("2026-10-20", { HODL: 1 }, 1)])],
      ["pending fund not listed", payload([day("2026-10-20", {}, 1, ["HODL"])])],
      ["as of another day", { ...payload(), asOf: "2026-10-19" }],
      ["a fund twice", { ...payload(), funds: [...payload().funds, payload().funds[0]!] }],
    ];
    for (const [, value] of broken) expect(() => validateCryptoEtfFlows(value, "BTC")).toThrow("invalid crypto ETF flows");
  });

  test("a server still without flows reads as not available yet, not a failure", async () => {
    const client = { getCloudCryptoEtfFlows: async () => { throw new ApiRequestError("flows_unavailable", 503); } };
    await expect(fetchCryptoEtfFlows("BTC", client)).rejects.toThrow("Crypto ETF flows are not available yet.");
  });
});

describe("crypto ETF flows figures", () => {
  test("flows keep their sign, and a figure that rounds to zero shows none", () => {
    expect([formatFlow(665.2), formatFlow(-83.6), formatFlow(-0.04), formatFlow(0), formatFlow(null)])
      .toEqual(["+665.2", "-83.6", "0.0", "0.0", "—"]);
    expect(formatFlowAmount(57_470)).toBe("+$57.47B");
    expect(formatFlowAmount(-6.7)).toBe("-$6.70M");
  });

  test("the summary and the running total use every day, a range cuts only what is listed", () => {
    const flows = payload();
    expect(cryptoEtfFlowSummary(flows)).toMatchObject({ week: null, month: null, firstDate: "2026-10-16" });
    expect(cryptoEtfFlowSummary(flows).sinceLaunch).toBeCloseTo(437.6, 6);
    expect(cumulativeFlows(flows).map((point) => Number(point.value.toFixed(1)))).toEqual([-82.4, 444.3, 437.6]);
    // A month back from the newest day, that day itself left out.
    const year = [day("2026-10-20", {}, 1), day("2026-09-21", {}, 1), day("2026-09-20", {}, 1)];
    expect(daysInRange(year, "1M").map((entry) => entry.date)).toEqual(["2026-10-20", "2026-09-21"]);
    expect(daysInRange(year, "ALL")).toHaveLength(3);
  });
});

test("the report marks a fund the newest day still waits on as pending", async () => {
  const stub = spyOn(apiClient, "getCloudCryptoEtfFlows").mockImplementation(async () => payload());
  try {
    const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: { asset: "btc", limit: 20 } };
    const result = await cryptoEtfFlowsHeadless.load(args, {} as HeadlessPaneContext) as HeadlessRowsResult;
    const text = renderHeadlessPaneText(cryptoEtfFlowsHeadless, result, args, "ETFF", deriveHeadlessFreshness(cryptoEtfFlowsHeadless, result));
    const latest = text.split("\n").find((line) => line.startsWith("2026-10-20"))!;
    expect(latest).toMatch(/2026-10-20\s+-6\.7\s+pending\s+\+3\.6\s+-10\.3\s+IBIT/);
    expect(text).toContain("2026-10-20: -$6.70M (IBIT pending)");
    expect(text).toContain("Farside Investors");
  } finally {
    stub.mockRestore();
  }
});
