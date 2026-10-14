import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { captureConsole } from "../../test-support/console";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import { runPaneFunction } from ".";

let finra: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  finra?.mockRestore();
  // A list that finds nothing sets the exit status; it must not become the test run's.
  process.exitCode = 0;
});

/** FINRA settles GME; every other name has no settlement. */
beforeEach(() => {
  finra = spyOn(apiClient, "getCloudShortInterest").mockImplementation(async (symbol: string) => symbol === "GME"
    ? { status: "success", data: { symbol, issueName: "GameStop", points: [
      { settlementDate: "2026-09-30", sharesShort: 42_670_000, previousSharesShort: 39_000_000, averageDailyVolume: null, daysToCover: 3.98, changePercent: 9.2, revised: false },
    ] } } as never
    : { status: "empty" } as never);
});

async function runSiw(...args: string[]) {
  const persistence = new AppPersistence(":memory:");
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloomberb-list-exit-test"),
    dataProvider: createTestDataProvider(),
    persistence,
    store: new TickerRepository(persistence.tickers),
  });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  process.exitCode = 0;
  const { exitCode } = await captureConsole(() => runPaneFunction(["SIW", ...args], cli.context));
  const data = cli.printed[0]!.result.data as { rowCount: number; symbols: string[]; errors: string[] };
  return { exitCode: exitCode ?? 0, ...data };
}

test("fn SIW exits 1 when no name resolved and 0 when some did, naming the ones left out", async () => {
  // Every entry skipped: each is named with its reason, and nothing is left to look up.
  expect(await runSiw("BTC-USD", "BRK-B-nonsense")).toMatchObject({
    exitCode: 1,
    rowCount: 0,
    errors: ["Left out: BTC-USD: not a US ticker symbol; BRK-B-NONSENSE: not a US ticker symbol."],
  });
  // Names looked up that FINRA has nothing for.
  expect(await runSiw("ZZZZ")).toMatchObject({ exitCode: 1, rowCount: 1 });
  // One name with data is a result; the one skipped stays listed.
  expect(await runSiw("GME;BTC-USD")).toMatchObject({
    exitCode: 0,
    symbols: ["GME"],
    errors: ["Left out: BTC-USD: not a US ticker symbol."],
  });
});
