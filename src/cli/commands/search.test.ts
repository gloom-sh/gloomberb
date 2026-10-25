import { expect, test } from "bun:test";
import type { PrintedCliResult } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { ProviderBusyError } from "../../sources/provider-errors";
import { DataServiceUnreachableError } from "../../utils/network-failure";
import type { TickerRecord } from "../../types/ticker";
import { search } from "./search";

/**
 * A rate-limited catalogue printed "No matches found." and exited 0, which
 * reads as "this company does not exist" (Eagle Bulk, 2026-10-18), and so did
 * a search offline or through a proxy that never answered.
 */
test("a search the data service was too busy for or never answered fails, unlike a search that found nothing", async () => {
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

  // No answer at all: the command fails as any command offline does, "couldn't reach", exit 1.
  const offline = await run(async () => { throw new DataServiceUnreachableError(new TypeError("Failed to fetch")); });
  expect(offline.failure).toBeInstanceOf(DataServiceUnreachableError);
  expect(offline.printed).toEqual([]);

  // Nothing found is an answer: an empty list and the catalog hint, no failure.
  const empty = await run(async () => []);
  expect(empty.failure).toBeNull();
  expect(empty.printed[0]!.data).toEqual([]);

  // A saved ticker that matches still answers while the service is busy.
  const partial = await run(busy, [createTestTicker("EGLE", "Eagle Bulk Shipping Inc.")]);
  expect(partial.failure).toBeNull();
  expect((partial.printed[0]!.data as Array<{ symbol: string }>).map((row) => row.symbol)).toEqual(["EGLE"]);
});

test("a name typed in kana or kanji is searched as typed, matches no saved ticker, and says what to type when nothing lists it", async () => {
  const saved = ["AAPL", "AMC", "AMZN", "BRK.B", "BTC-USD"].map((symbol) => createTestTicker(symbol, symbol));
  const run = async (query: string, answer: (query: string) => Promise<never[]>) => {
    const asked: string[] = [];
    const dataProvider = createTestDataProvider({ search: async (query: string) => { asked.push(query); return answer(query); } });
    const initMarketData = async () => ({ store: { loadAllTickers: async () => saved }, dataProvider, persistence: { close() {} } }) as never;
    const printed: PrintedCliResult["result"][] = [];
    const failure = await search(query, { initMarketData, printResult: (result) => { printed.push(result); } }).then(() => null, (error: unknown) => error);
    return { asked, failure, printed: printed[0] };
  };
  // The service fails on every name in another script; that is no busy search, and the saved list is no match.
  for (const query of ["ゲームストップ", "任天堂"]) {
    const { asked, failure, printed } = await run(query, async () => { throw new ProviderBusyError(); });
    expect(asked).toContain(query);
    expect(failure).toBeNull();
    expect(printed!.data).toEqual([]);
    expect(printed!.warnings).toEqual(["No matches. Try the ticker or the English name."]);
  }
  // A Latin name the service is too busy for is still busy.
  expect((await run("gamestop", async () => { throw new ProviderBusyError(); })).failure).toMatchObject({ code: "search_busy" });
});
