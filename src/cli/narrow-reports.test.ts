import { afterEach, expect, test } from "bun:test";
import type { CentralBankRatesPayload, CentralBankRow } from "../api-client/central-bank-rates";
import type { MoneyMarketRow, MoneyMarketsPayload } from "../api-client/money-markets";
import type { RateContract, RateMeeting, RatePathPayload } from "../api-client/rates";
import { setCloudApiFetchTransport } from "../api-client/request";
import { centralBankRatesHeadless } from "../plugins/builtin/central-bank-rates/headless";
import { moneyMarketsHeadless } from "../plugins/builtin/money-markets/headless";
import { ratePathHeadless } from "../plugins/builtin/rate-path/headless";
import { createTestCliContext } from "../test-support/cli-context";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../test-support/headless";
import type { HeadlessPaneDefinition, HeadlessPaneLoadArgs } from "../types/plugin";
import { setCliWidthOverride, visibleLength } from "../utils/cli-output";
import { overviewCliCommands } from "./commands/overview";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { renderHeadlessPaneText } from "./pane-functions/headless";
import { serializeCliResult } from "./result";

const percentile = (value: number | null) => ({ value, rank: 10, sampleCount: 250, windowStart: "2025-10-11", windowEnd: "2026-10-11", min: 1, max: 5, mean: 3 });

function policyRow(overrides: Partial<CentralBankRow>): CentralBankRow {
  return { id: "US", label: "United States", countryCodes: ["US"], centralBank: "Federal Reserve", instrument: "Fed funds target range",
    source: "fred", sourceUrl: null, sourceSeriesIds: ["DFEDTARL"], unit: "percent", publicationFrequency: "daily",
    value: 3.875, range: { lower: 3.75, upper: 4 }, asOf: "2026-10-11", lagDays: 1, fetchedAt: "2026-10-12T08:00:00Z",
    changeBps: 25, lastChangeDate: "2026-09-17", previousValue: 3.625, previousAsOf: "2026-09-16", direction: "hike",
    percentile: percentile(86), history: [], status: "available", unavailableReason: null, notes: [], nextMeeting: null, ...overrides };
}

const centralBankRates: CentralBankRatesPayload = { generatedAt: "2026-10-12T08:00:00Z", status: "available", gaps: [], rows: [
  policyRow({}),
  policyRow({ id: "JP", label: "Japan", instrument: "Uncollateralized overnight call rate target", value: 1.25, range: null,
    asOf: "2026-10-06", lastChangeDate: "2026-09-24", previousValue: 1, previousAsOf: "2026-09-23", percentile: percentile(98) }),
  policyRow({ id: "TR", label: "Turkey", instrument: "1-week repo rate", value: 37, range: null, asOf: "2026-10-02", changeBps: -100,
    lastChangeDate: "2026-01-23", previousValue: 38, previousAsOf: "2026-01-22", direction: "cut", percentile: percentile(34) }),
  policyRow({ id: "AR", label: "Argentina", instrument: "No adopted policy rate", value: null, range: null, asOf: null, lagDays: null,
    changeBps: null, lastChangeDate: null, previousValue: null, previousAsOf: null, direction: "unavailable", percentile: percentile(null),
    status: "unavailable", unavailableReason: "no-policy-rate" }),
] };

function moneyRow(id: string, overrides: Partial<MoneyMarketRow> = {}): MoneyMarketRow {
  return { id, label: id.toUpperCase(), seriesId: id.toUpperCase(), sourceSeriesIds: [id.toUpperCase()], sourceUrl: null, group: "rates",
    unit: "percent", frequency: "daily", value: 3.87, asOf: "2026-10-08", previousValue: 3.88, previousAsOf: "2026-10-07", change: -1,
    changeUnit: "basis-points", percentile: percentile(78), history: [], status: "available", fetchedAt: "2026-10-12T08:00:00Z",
    unavailableReason: null, notes: [], ...overrides };
}

const moneyMarkets: MoneyMarketsPayload = { generatedAt: "2026-10-12T08:00:00Z", status: "available",
  rows: [moneyRow("sofr"), moneyRow("effr", { value: 3.88, change: 0 }), moneyRow("iorb", { value: 3.9, asOf: "2026-10-12", previousAsOf: "2026-10-11" })],
  netLiquidity: moneyRow("net-liquidity", { group: "liquidity", unit: "usd-billions", changeUnit: "usd-billions" }),
  billsCurve: { asOf: "2026-10-08", status: "available", basis: "discount", points: [], comparisons: [],
    slope: { valueBps: null, asOf: null, percentile: percentile(null), history: [] } } };

const meeting = (date: string, impliedRate: number, odds: [number, number]): RateMeeting => ({
  date, impliedRate, targetMidpoint: impliedRate, changeBps: (impliedRate - 3.875) * 100, percentile: 90, samples: 251,
  asOf: "2026-10-12T09:21:00Z", method: "following-month", reason: null,
  probabilities: [{ targetMidpoint: 3.875, probability: odds[0] }, { targetMidpoint: 4.125, probability: odds[1] }],
});
const contract = (symbol: string, month: string, price: number): RateContract => ({
  symbol, month, price, impliedRate: 100 - price, asOf: "2026-10-12T09:16:00Z", percentile: 91, samples: 251, status: "available", stale: false,
});
const metric = { value: 3.88, asOf: "2026-10-08", percentile: 86, samples: 249, source: "fred" as const, stale: false };

const ratePath: RatePathPayload = {
  asOf: "2026-10-12T09:25:00Z", fetchedAt: "2026-10-12T09:30:00Z", stale: false, status: "available", gaps: [], ghosts: [],
  current: { effr: metric, targetLower: { ...metric, value: 3.75, asOf: "2026-10-11" }, targetUpper: { ...metric, value: 4, asOf: "2026-10-11" } },
  meetings: [meeting("2026-10-28", 3.92, [0.82, 0.18]), meeting("2026-12-09", 4.14, [0.03, 0.97]), meeting("2027-01-27", 4.24, [0.56, 0.44])],
  fedFunds: [contract("ZQV26.CBT", "2026-10", 96.115), contract("ZQX26.CBT", "2026-11", 96.075)],
  sofr: [contract("SR3Z26.CME", "2026-12", 95.76), contract("SR3H27.CME", "2027-03", 95.48)],
  probabilityAssumption: "Two outcomes",
  dotPlot: { asOf: "2026-09-16", sourceUrl: "https://www.federalreserve.gov", points: [] },
  schedule: { sourceUrl: "https://www.federalreserve.gov", verifiedAt: "2026-10-01", through: "2027-12-08" },
  slope: { valueBps: null, percentile: null, samples: 0, asOf: null },
};

const fredCatalog = { series: [
  { id: "DFEDTARL", title: "Federal Funds Target Range, Lower Limit", group: "Rates" },
  { id: "DFEDTARU", title: "Federal Funds Target Range, Upper Limit", group: "Rates" },
  { id: "DCPF3M", title: "3-Month AA Financial Commercial Paper Rate", group: "Money markets" },
  { id: "BOGZ1FL153064486Q", title: "Households and Nonprofit Organizations; Corporate Equities Held (Z.1 Financial Accounts)", group: "Valuation" },
] };

afterEach(() => {
  setCliWidthOverride(null);
  setCloudApiFetchTransport(null);
});

async function headlessText(definition: HeadlessPaneDefinition, apiClient: object, args: HeadlessPaneLoadArgs = createTestHeadlessArgs()) {
  const result = await definition.load(args, createTestHeadlessContext({ apiClient: apiClient as never }));
  return renderHeadlessPaneText(definition, result, args, "Report");
}

async function fredListText() {
  setCloudApiFetchTransport(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(fredCatalog) }) as Response);
  const cli = createTestCliContext();
  await overviewCliCommands.find((command) => command.name === "fred")!.execute(["--list", "rate"], cli.context);
  const { result, options } = cli.printed[0]!;
  return serializeCliResult(result, DEFAULT_CLI_OPTIONS, options);
}

const reports: Record<string, () => Promise<string>> = {
  CBR: () => headlessText(centralBankRatesHeadless, { getCloudCentralBankRates: async () => centralBankRates }),
  WIRP: () => headlessText(ratePathHeadless, { getCloudRatePath: async () => ratePath }),
  BTMM: () => headlessText(moneyMarketsHeadless, { getCloudMoneyMarkets: async () => moneyMarkets }, createTestHeadlessArgs({ options: { tab: "rates" } })),
  "fred --list rate": fredListText,
};

test("at 40 and 60 columns CBR, WIRP, BTMM and fred --list fit, keep every date and figure whole and tell series apart", async () => {
  for (const width of [40, 60]) {
    setCliWidthOverride(width);
    for (const [name, render] of Object.entries(reports)) {
      const text = await render();
      const lines = text.split("\n");
      expect({ name, width, wide: lines.filter((line) => visibleLength(line) > width) }).toEqual({ name, width, wide: [] });
      // A cut date or figure ends in a digit, sign or unit before the ellipsis (`2026-10-…`, `3.8…`).
      expect({ name, width, cut: lines.filter((line) => /[\d%.,:+-]…/.test(line)) }).toEqual({ name, width, cut: [] });
    }
    const cbr = await reports.CBR!();
    for (const date of ["2026-10-11", "2026-09-17", "2026-10-06", "2026-09-24", "2026-01-23"]) expect(cbr).toContain(date);
    expect(cbr).toContain("Uncollateralized overnight");
    const wirp = await reports.WIRP!();
    // The odds of the next two meetings only, whole.
    expect(wirp).toContain("3.875% 82% / 4.125% 18%");
    expect(wirp).toContain("3.875% 3% / 4.125% 97%");
    expect(wirp).not.toContain("3.875% 56% / 4.125% 44%");
    expect(wirp).toContain("2027-01-27");
    const fred = await reports["fred --list rate"]!();
    expect(fred).toContain("Lower Limit");
    expect(fred).toContain("Upper Limit");
  }
});
