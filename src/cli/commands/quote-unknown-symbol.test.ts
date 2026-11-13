import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { AssetDataRouter } from "../../sources/provider-router";
import { createGloomberbCloudProvider } from "../../sources/gloomberb-cloud";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { resetBoardCoins } from "../board-coins";
import { withSearchHints } from "../not-a-ticker";
import { marketDataCliCommands } from "./market";

const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

beforeEach(() => {
  resetBoardCoins();
  spyOn(apiClient, "getCloudFuturesContract").mockRejectedValue(new Error("Fixture has no contract terms"));
});
afterEach(() => {
  process.exitCode = 0;
  resetBoardCoins();
  mock.restore();
});

const APPLE = { symbol: "AAPL", name: "Apple Inc.", currency: "USD", price: 190, previousClose: 189, change: 1, changePercent: 0.53,
  exchangeName: "NASDAQ", listingExchangeName: "NASDAQ", lastUpdated: Date.now(), dataSource: "delayed", providerId: "gloomberb-cloud" };

/**
 * Gloom Cloud as it answers for symbols nothing lists (the batch, the quote, the symbol's ^ form: "not found"; an
 * empty search), the real router and cloud provider above it, and only the network stubbed. Every request is recorded in
 * the order it starts; the batch answers when `release` is called, so what starts beside it is seen.
 */
function cloud(listed: Record<string, unknown> = {}, searchMs = 0) {
  const requests: string[] = [];
  let release: () => void = () => {};
  const batchAnswered = new Promise<void>((resolve) => { release = resolve; });
  spyOn(apiClient as never, "request" as never).mockImplementation((async (path: string, init?: { method?: string; body?: string }) => {
    requests.push(`${init?.method ?? "GET"} ${path.split("?")[0]}${/[?&](?:q|symbol|search)=([^&]*)/.exec(path)?.[1] ? ` ${decodeURIComponent(/[?&](?:q|symbol|search)=([^&]*)/.exec(path)![1]!)}` : ""}`);
    if (path.startsWith("/market/quotes/batch")) {
      await batchAnswered;
      const { targets } = JSON.parse(init!.body!) as { targets: Array<{ symbol: string; exchange?: string }> };
      return { status: "success", data: { items: targets.map((target) => listed[target.symbol]
        ? { symbol: target.symbol, exchange: target.exchange ?? "", status: "success", data: listed[target.symbol] }
        : { symbol: target.symbol, exchange: target.exchange ?? "", status: "empty", data: null, reasonCode: "NOT_FOUND" }) } };
    }
    if (path.startsWith("/market/quote?")) {
      const symbol = new URL(`https://x${path}`).searchParams.get("symbol")!;
      return listed[symbol] ? { status: "success", data: listed[symbol] } : { status: "empty", reasonCode: "NOT_FOUND", data: null };
    }
    if (path.startsWith("/market/search")) {
      const query = new URL(`https://x${path}`).searchParams.get("q")!;
      if (searchMs) await new Promise((resolve) => setTimeout(resolve, searchMs));
      return { status: "success", data: listed[query] ? [{ symbol: query, name: "Apple Inc.", exchange: "NASDAQ", type: "EQUITY", currency: "USD" }] : [] };
    }
    if (path.startsWith("/market/ticker-changes")) return { symbol: "X", changes: [], moved: null, formerly: null, listedName: null };
    if (path.startsWith("/cloud/perps/board")) return { rows: [] };
    if (path.startsWith("/cloud/crypto/markets")) return { assets: [] };
    throw new Error(`unexpected request ${path}`);
  }) as never);
  return { requests, release: () => release() };
}

async function runQuote(args: string[], service: ReturnType<typeof cloud>) {
  const cli = createTestCliContext({ dataProvider: new AssetDataRouter(createGloomberbCloudProvider()) });
  const done = quoteCommand.execute(args, cli.context).catch(() => {});
  return {
    finish: async () => {
      service.release();
      await done;
      const printed = cli.printed[0] as PrintedCliResult | undefined;
      return {
        warnings: (printed?.result.warnings ?? []) as string[],
        rows: (printed?.result.data ?? []) as Array<{ target: { symbol: string }; quote: unknown }>,
      };
    },
  };
}

// The client remembers a listing the service said is not found for a minute, so each test asks about its own.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// `quote QWZXQ` (never seen) sent ten requests, partly one after another, and took 3.4 to 4.3 s: the batch, the same
// symbol alone, its ^ form, a month of bars, a second search, the crypto board.
test("a symbol nothing lists is answered from the requests that start together, and nothing is read once the service says so", async () => {
  const service = cloud();
  const run = await runQuote(["QWZXQ"], service);
  // The batch has not answered: the symbol's changes, its venues and its index form are out beside it.
  await settle();
  expect([...service.requests].sort()).toEqual([
    "GET /cloud/perps/board QWZXQ", "GET /market/quote ^QWZXQ", "GET /market/search QWZXQ", "GET /market/ticker-changes QWZXQ", "POST /market/quotes/batch",
  ].sort());
  const { warnings } = await run.finish();
  expect(withSearchHints(warnings.join("\n"), ["QWZXQ"])).toBe("Not a ticker: QWZXQ. Try `gloom search QWZXQ`.");
  // No more after it: not the symbol alone again, bars, a second search, the board of coins.
  expect(service.requests).toHaveLength(5);
});

test("a word that names a coin is answered from the coins this build knows, with no read of the crypto board", async () => {
  const service = cloud();
  const { warnings } = await (await runQuote(["TETHER"], service)).finish();
  expect(withSearchHints(warnings.join("\n"), ["TETHER"])).toBe("Not a ticker: TETHER. Did you mean USDT-USD (Tether USDt)?");
  expect(service.requests.some((request) => request.includes("crypto"))).toBe(false);
});

test("a listed symbol beside an unknown one is quoted as before, and only the unknown one is asked about further", async () => {
  const service = cloud({ AAPL: APPLE });
  const { rows, warnings } = await (await runQuote(["AAPL", "ZZZQQ"], service)).finish();
  expect(rows.map((row) => [row.target.symbol, row.quote != null])).toEqual([["AAPL", true], ["ZZZQQ", false]]);
  expect(warnings.join("\n")).toContain("Not a ticker: ZZZQQ.");
  // AAPL is listed, so its ^ form is not looked for; ZZZQQ is not, so its is, and it is not asked for again alone.
  expect(service.requests.filter((request) => request === "GET /market/quote ^AAPL" || request === "GET /market/quote ^ZZZQQ")).toEqual(["GET /market/quote ^ZZZQQ"]);
  expect(service.requests).not.toContain("GET /market/quote ZZZQQ");
  expect(service.requests.some((request) => /history|crypto/.test(request))).toBe(false);
});

test("a symbol's index form does not wait for a venue search slower than the batch that said it is not a ticker", async () => {
  const service = cloud({}, 300);
  const run = await runQuote(["QWZXW"], service);
  service.release();
  await settle();
  // The batch answered; the search has 250 ms to go, and the index form is already out.
  expect(service.requests).toContain("GET /market/quote ^QWZXW");
  await run.finish();
  expect(service.requests).toHaveLength(5);
});
