import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { AssetDataRouter } from "../../sources/provider-router";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import type { Quote } from "../../types/financials";
import { marketDataCliCommands } from "./market";

// Tue 13 Oct 2026, after hours, BRK.B saved on NYSE. At 21:27:11
// `quote BRK.B BRK-B` read the service's 488.97 printed 21:11; at 21:28:44
// `quote BRK.B:NYSE` read 520.88 printed 21:13, the delayed feed having moved
// on. Each form's copy was then fresh in the local cache for five minutes, so
// `quote BRK.B BRK-B BRK.B:NYSE` printed both prints for one listing, while
// the service answered every form with one quote all along.

const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;
const at = (time: string) => Date.parse(time);

/** The service's delayed after-hours quote of BRK.B, named as the form asked. */
function served(symbol: string, price: number, printed: string): Quote {
  return createTestQuote({
    symbol, price, currency: "USD", change: 2.99, changePercent: 0.58, previousClose: 517.6,
    regularClose: 520.59, postMarketPrice: price, extendedSessionPrint: true,
    lastUpdated: at(printed), marketState: "POST", sessionConfidence: "derived",
    listingExchangeName: "NYSE", exchangeName: "NYSE", instrumentType: "EQUITY",
    name: "Berkshire Hathaway Inc.", providerId: "gloomberb-cloud", dataSource: "delayed", stale: false,
  });
}

let clock: ReturnType<typeof spyOn>;
let persistence: AppPersistence;
beforeEach(() => {
  clock = spyOn(Date, "now");
  persistence = new AppPersistence(":memory:");
});
afterEach(() => {
  clock.mockRestore();
  persistence.close();
});

function service() {
  const state = { price: 488.9713, printed: "2026-10-13T21:11:14.220Z", fails: false, asked: [] as string[][] };
  const provider = createTestDataProvider({
    id: "gloomberb-cloud",
    priority: 1,
    getQuotesBatch: async (targets) => {
      state.asked.push(targets.map((target) => `${target.symbol}:${target.exchange}`));
      if (state.fails) throw new Error("Fixture service unavailable");
      return targets.map((target) => ({ target, quote: served(target.symbol, state.price, state.printed) }));
    },
  });
  const router = new AssetDataRouter(provider, [], persistence.resources);
  return { router, state };
}

async function quote(router: AssetDataRouter, args: string[]) {
  const cli = createTestCliContext({
    dataProvider: router,
    // BRK.B is a saved ticker on NYSE; BRK-B is not.
    store: {
      loadTicker: async (symbol: string) => symbol === "BRK.B" ? createTestTicker("BRK.B", "Berkshire Hathaway Inc.", { exchange: "NYSE" }) : null,
      loadAllTickers: async () => [],
    },
  });
  await quoteCommand.execute(args, cli.context);
  const printed = cli.printed[0] as PrintedCliResult;
  return (printed.result.data as Array<{ target: { symbol: string }; quote: Quote | null }>)
    .map((row) => [row.target.symbol, row.quote?.price ?? null, row.quote?.lastUpdated ?? null]);
}

test("every form of one listing prints the service's quote of the moment, not its own local copy", async () => {
  const { router, state } = service();
  clock.mockReturnValue(at("2026-10-13T21:27:11Z"));
  await quote(router, ["BRK.B", "BRK-B"]);
  clock.mockReturnValue(at("2026-10-13T21:28:44Z"));
  state.price = 520.8838;
  state.printed = "2026-10-13T21:13:37.267Z";
  await quote(router, ["BRK.B:NYSE"]);

  clock.mockReturnValue(at("2026-10-13T21:29:30Z"));
  const now = [520.8838, at("2026-10-13T21:13:37.267Z")];
  // One command lists BRK.B once whichever way it is typed; BRK-B is its own command.
  expect(await quote(router, ["BRK.B", "BRK.B:NYSE"])).toEqual([["BRK.B", ...now], ["BRK.B:NYSE", ...now]]);
  expect(await quote(router, ["BRK-B"])).toEqual([["BRK-B", ...now]]);

  // With the service unreachable, each form still prints its own last copy.
  state.fails = true;
  state.price = 520.32;
  expect(await quote(router, ["BRK-B"])).toEqual([["BRK-B", ...now]]);
  expect(await quote(router, ["BRK.B:NYSE"])).toEqual([["BRK.B:NYSE", ...now]]);
});
