import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { FxInterventionsPayload } from "../../api-client/fx-interventions";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestCliContext } from "../../test-support/cli-context";
import { marketDataCliCommands } from "./market";

afterEach(() => setSystemTime());

const fx = marketDataCliCommands.find((command) => command.name === "fx")!;
const history = marketDataCliCommands.find((command) => command.name === "history")!;
const USD_SOLD = { sold: "USD", bought: "JPY", pair: "the US dollar (sold) the Japanese yen (bought)" };

const RECORD: FxInterventionsPayload = {
  authority: "Japan Ministry of Finance",
  status: "available",
  days: [],
  interventions: [
    { from: "2024-04-29", to: "2024-05-01", days: 2, amountJpy: 9_788_500_000_000, ...USD_SOLD },
    { from: "2024-07-11", to: "2024-07-12", days: 2, amountJpy: 5_534_800_000_000, ...USD_SOLD },
    { from: "2026-04-30", to: "2026-04-30", days: 1, amountJpy: 6_278_700_000_000, ...USD_SOLD },
  ],
  dailyThrough: "2026-06-30",
  months: [{
    from: "2026-07-30", to: "2026-08-26", amountJpy: 15_399_300_000_000, releasedOn: "2026-08-28", daysKnown: "none", undatedAmountJpy: 15_399_300_000_000,
  }],
  quarters: [],
  fetchedAt: "2026-11-07T07:37:53.746Z",
  sourceUrl: "https://www.mof.go.jp/english/policy/international_policy/reference/feio/index.html",
  notes: [],
};

function pairQuote(symbol: string, price: number): Quote {
  return {
    symbol, name: symbol, price, currency: symbol.slice(3, 6), change: 0, changePercent: 0, exchangeName: "CCY", instrumentType: "CURRENCY",
    providerId: "gloomberb-cloud", dataSource: "delayed", lastUpdated: Date.parse("2026-11-06T21:59:00Z"),
  } as Quote;
}

const DAILY = ["2024-04-26", "2024-04-29", "2024-04-30", "2024-05-01", "2024-05-02"];

/** The commands over the given quotes and bars, with the record Gloom Cloud serves; every read of it is counted. */
function harness(bars = { resolution: "1d", dates: DAILY }) {
  let reads = 0;
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-fx-interventions-fixture"),
    fxInterventions: async () => { reads += 1; return RECORD; },
    dataProvider: createTestDataProvider({
      getQuotesBatch: async (targets: { symbol: string; exchange: string }[]) => targets.map((target) => (
        { target, quote: pairQuote(target.symbol, target.symbol === "USDJPY=X" ? 158.51071 : 1.15) }
      )),
      getQuote: async () => createTestQuote({ symbol: "USDJPY=X", currency: "JPY", exchangeName: "CCY", instrumentType: "CURRENCY" }),
      getPriceHistoryWithMetadata: async () => ({
        resolution: bars.resolution,
        points: bars.dates.map((date, index) => (
          { date: new Date(`${date}T00:00:00Z`), open: 158 - index, high: 160 - index, low: 155 - index, close: 157 - index }
        )),
      }),
    } as never),
  });
  return { cli, reads: () => reads, warnings: () => cli.printed.map(({ result }) => result.warnings ?? []) };
}

// Checking USD/JPY before an intervention scare, a new user found no dates, amounts or levels of Japan's interventions anywhere.
test("a yen pair's rate names Japan's latest intervention in it; a conversion and another pair do not read the record", async () => {
  setSystemTime(new Date("2026-11-07T02:05:00Z"));
  const run = harness();
  await fx.execute(["USD/JPY"], run.cli.context);
  expect(run.warnings()[0]).toContain(
    "Japan's Ministry of Finance reported ¥15,399.3 billion of intervention from 30 Jul to 26 Aug 2026, a monthly total released 28 Aug 2026: its days and pair come with the quarterly release. "
    + "Its last dated intervention in USD/JPY: 30 Apr 2026, ¥6,278.7 billion of dollars sold for yen. Records through 26 Aug 2026.",
  );
  await fx.execute(["100", "JPY"], run.cli.context);
  await fx.execute(["EUR/USD"], run.cli.context);
  expect(run.reads()).toBe(1);
  expect(run.warnings().slice(1).flat().join(" ")).not.toContain("Ministry of Finance");
});

test("a yen pair's bars name the interventions they span, through the whole of the last weekly bar's week", async () => {
  const run = harness();
  await history.execute(["USDJPY=X", "--from", "2024-04-26", "--to", "2024-05-02"], run.cli.context);
  expect(run.warnings()[0]).toContain("Japan's Ministry of Finance bought yen in USD/JPY in these bars: 29 Apr–1 May 2024 ¥9.8tn.");
  // The last bar is the week of Monday 8 July: 11 and 12 July are in it.
  const weekly = harness({ resolution: "1wk", dates: ["2024-06-17", "2024-06-24", "2024-07-01", "2024-07-08"] });
  await history.execute(["USDJPY=X", "--from", "2024-06-17", "--to", "2024-07-12"], weekly.cli.context);
  expect(weekly.warnings()[0]).toContain("Japan's Ministry of Finance bought yen in USD/JPY in these bars: 11–12 Jul 2024 ¥5.5tn.");
});
