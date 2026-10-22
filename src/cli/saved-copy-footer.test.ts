import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { CachedQuery } from "../data/cached-query";
import { collectSavedCopies, savedCopyServedAt } from "../data/saved-copies";
import { AssetDataRouter } from "../sources/provider-router";
import { createTestCliContext } from "../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { marketDataCliCommands } from "./commands/market";
import { DEFAULT_CLI_OPTIONS } from "./options";
import { formatFreshnessLine, type ReportFreshness } from "./pane-functions/freshness";
import { serializeCliResult } from "./result";

/**
 * Offline, a command answers from the copy it saved earlier, and used to end
 * with the live or delayed line as if it had just read it. Whatever it shows
 * from a saved copy after a failed refresh now ends `couldn't refresh; saved
 * <time>`, in text, `--json` and `--csv`, and only for that command.
 */

const at = (time: string) => Date.parse(time);
const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;
const unreachable = () => Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });

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

/** Gloom Cloud's delayed BTC-USD quote, until `state.offline`. */
function service() {
  const state = { offline: false };
  const quote = () => createTestQuote({
    symbol: "BTC-USD", name: "Bitcoin", price: 81_339.03, currency: "USD", change: -2_685.41, changePercent: -3.2,
    lastUpdated: at("2026-10-22T21:52:00Z"), marketState: "REGULAR", instrumentType: "CRYPTOCURRENCY",
    providerId: "gloomberb-cloud", dataSource: "delayed", delayMinutes: 15, stale: false,
  });
  const provider = createTestDataProvider({
    id: "gloomberb-cloud",
    priority: 1,
    getQuote: async () => { if (state.offline) throw unreachable(); return quote(); },
    getQuotesBatch: async (targets) => {
      if (state.offline) throw unreachable();
      return targets.map((target) => ({ target, quote: quote() }));
    },
  });
  return { router: new AssetDataRouter(provider, [], persistence.resources), state };
}

/** `quote BTC-USD` as one command, printed as text, `--json` and `--csv`. */
function runQuote(router: AssetDataRouter) {
  const cli = createTestCliContext({ dataProvider: router });
  return collectSavedCopies(async () => {
    await quoteCommand.execute(["BTC-USD"], cli.context);
    const { result, options } = cli.printed[0]!;
    return {
      text: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, color: false }, options),
      json: JSON.parse(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, options)),
      csv: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options),
    };
  });
}

test("a quote served from the saved copy because the refresh failed ends with when it was saved", async () => {
  const { router, state } = service();
  clock.mockReturnValue(at("2026-10-22T22:08:00Z"));
  expect((await runQuote(router)).text).toContain("15 min delayed");

  state.offline = true;
  clock.mockReturnValue(at("2026-10-22T22:20:00Z"));
  const offline = await runQuote(router);
  expect(offline.text).toContain("$81,339.03");
  expect(offline.text).toContain("Source: Gloom Cloud · Thu 22 Oct 2026 21:52 UTC · couldn't refresh; saved 22:08 UTC");
  expect(offline.text).not.toContain("15 min delayed");
  expect(offline.json.metadata.freshness.savedAt).toBe("2026-10-22T22:08:00.000Z");
  expect(offline.csv).toContain("# Saved time: 2026-10-22T22:08:00.000Z");

  // The next command starts over: back online, it reads as delayed again.
  state.offline = false;
  expect(savedCopyServedAt()).toBeNull();
  expect((await runQuote(router)).text).toContain("15 min delayed");
});

test("any cached answer is noted, the oldest save wins, and nothing is noted outside a command", async () => {
  const saved = (fetchedAt: number) => ({ value: "saved", fetchedAt, staleAt: fetchedAt + 1, expiresAt: fetchedAt + 3_600_000, source: "test" });
  clock.mockReturnValue(at("2026-10-22T22:20:00Z"));
  const query = (fetchedAt: number) => new CachedQuery({ read: () => saved(fetchedAt), fetch: async () => { throw unreachable(); } });

  await query(at("2026-10-22T22:10:00Z")).load();
  expect(savedCopyServedAt()).toBeNull();

  const noted = await collectSavedCopies(async () => {
    await query(at("2026-10-22T22:10:00Z")).load();
    await query(at("2026-10-22T21:40:00Z")).load();
    return savedCopyServedAt();
  });
  expect(noted).toBe(at("2026-10-22T21:40:00Z"));
});

test("a copy saved on another day than the report names that day", () => {
  const freshness: ReportFreshness = {
    source: "Gloom Cloud", asOf: "2026-10-22T21:52:00.000Z", status: "delayed", delayMinutes: 15,
    retrievedAt: "2026-10-23T08:00:00.000Z", savedAt: "2026-10-22T22:08:00.000Z",
  };
  expect(formatFreshnessLine(freshness)).toBe("Source: Gloom Cloud · Thu 22 Oct 2026 21:52 UTC · couldn't refresh; saved Thu 22 Oct 2026 22:08 UTC");
});
