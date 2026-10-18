import { expect, test } from "bun:test";
import type { PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { ProviderBusyError } from "../../sources/provider-errors";
import type { TickerRecord } from "../../types/ticker";
import { search } from "./search";

/**
 * A rate-limited catalogue printed "No matches found." and exited 0, which
 * reads as "this company does not exist" (Eagle Bulk, 2026-10-18).
 */
test("a search the data service was too busy to answer fails as retryable, unlike a search that found nothing", async () => {
  const run = async (answer: () => Promise<never[]>, tickers: TickerRecord[] = []) => {
    const dataProvider = createTestDataProvider({ search: answer });
    const initMarketData = async () => ({ store: { loadAllTickers: async () => tickers }, dataProvider, persistence: { close() {} } }) as never;
    const printed: PrintedCliResult["result"][] = [];
    const failure = await search("Eagle Bulk", { initMarketData, printResult: (result) => { printed.push(result); } }).then(() => null, (error: unknown) => error);
    return { failure, printed };
  };
  const busy = async () => { throw new ProviderBusyError(); };

  const unanswered = await run(busy);
  expect(unanswered.failure).toMatchObject({ code: "search_busy", retryable: true });
  expect(unanswered.printed).toEqual([]);

  // Nothing found is an answer: an empty list and the catalog hint, no failure.
  const empty = await run(async () => []);
  expect(empty.failure).toBeNull();
  expect(empty.printed[0]!.data).toEqual([]);

  // A saved ticker that matches still answers while the service is busy.
  const partial = await run(busy, [createTestTicker("EGLE", "Eagle Bulk Shipping Inc.")]);
  expect(partial.failure).toBeNull();
  expect((partial.printed[0]!.data as Array<{ symbol: string }>).map((row) => row.symbol)).toEqual(["EGLE"]);
});
