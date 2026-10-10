import { expect, setSystemTime, test } from "bun:test";
import { marketDataCliCommands } from "./market";
import { createTestCliContext } from "../../test-support/cli-context";

const options = marketDataCliCommands.find((command) => command.name === "options")!;

async function warningsFor(chain: object, stored: number, refreshError: unknown): Promise<string[] | undefined> {
  const cli = createTestCliContext({
    dataProvider: { getCachedQuery: () => ({ load: async () => ({
      value: chain, fetchedAt: stored, staleAt: stored, expiresAt: Infinity, source: "cloud", refreshError,
    }) }) },
  }, { refresh: true });
  await options.execute(["AAPL"], cli.context);
  return cli.printed[0]!.result.warnings;
}

test("options reports when a failed refresh falls back to a stored chain", async () => {
  const stored = Date.parse("2026-09-22T19:55:00Z");
  const chain = { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [] };
  const warnings = await warningsFor(chain, stored, new Error("429"));
  expect(warnings).toHaveLength(1);
  expect(warnings![0]).toContain("2026-09-22T19:55:00.000Z");
});

test("options flags a chain last observed before today's US open", async () => {
  // 09:45 New York: the delayed chain may still be yesterday's closing snapshot.
  setSystemTime(new Date("2026-09-23T13:45:00Z"));
  try {
    const warnings = [];
    for (const asOf of ["2026-09-22T19:59:59Z", "2026-09-23T13:31:00Z"]) {
      const chain = { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [], asOf };
      warnings.push(await warningsFor(chain, Date.now(), undefined));
    }
    expect(warnings[0]).toEqual(["No option trades this session yet (last trade 2026-09-22T19:59:59Z)"]);
    expect(warnings[1]).toBeUndefined();
  } finally {
    setSystemTime();
  }
});

const EXPIRIES = ["2027-12-17", "2028-03-17", "2028-06-16"].map((date) => Date.parse(`${date}T00:00:00Z`) / 1000);

function expiryProvider(contractExpiries: number[]) {
  const requests: unknown[][] = [];
  const contract = (expiration: number) => ({
    contractSymbol: "AAPL", strike: 100, currency: "USD", lastPrice: 1, change: 0, percentChange: 0, bid: 1, ask: 2,
    impliedVolatility: 0, inTheMoney: false, expiration, lastTradeDate: 0,
  });
  const dataProvider = {
    getOptionsChain: async (...args: unknown[]) => {
      requests.push(args);
      return { underlyingSymbol: "AAPL", expirationDates: EXPIRIES, calls: contractExpiries.map(contract), puts: [] };
    },
  };
  return { requests, cli: createTestCliContext({ dataProvider }) };
}

test("options takes --expiration as a date, asks for its UTC midnight, and rejects what it cannot read before asking", async () => {
  const hit = expiryProvider([EXPIRIES[1]!]);
  await options.execute(["AAPL", "--expiration", "2028-03-17"], hit.cli.context);
  expect(hit.requests[0]!.slice(0, 3)).toEqual(["AAPL", "", EXPIRIES[1]]);
  expect(hit.cli.printed[0]!.options!.rows!(hit.cli.printed[0]!.result.data)).toHaveLength(1);

  for (const bad of ["2028-02-30", "next-friday", "2028-3-17"]) {
    const miss = expiryProvider([]);
    await expect(options.execute(["AAPL", "--expiration", bad], miss.cli.context)).rejects.toThrow(`Invalid --expiration "${bad}"`);
    expect(miss.requests).toEqual([]);
  }
  await expect(options.execute(["AAPL", "--expiration"], expiryProvider([]).cli.context)).rejects.toThrow("--expiration needs a date");
});

test("options fails on an expiry the chain does not list, in dates, and on one the provider answered with other contracts", async () => {
  const unlisted = expiryProvider([]);
  await expect(options.execute(["AAPL", "--expiration", "2028-01-21"], unlisted.cli.context))
    .rejects.toThrow("no expiry 2028-01-21 for AAPL; available: 2027-12-17, 2028-03-17, 2028-06-16");
  expect(unlisted.cli.printed).toEqual([]);
  // Unix seconds read the same way, rendered as the date they fall on.
  await expect(options.execute(["AAPL", "--expiration", "1832025600"], expiryProvider([]).cli.context))
    .rejects.toThrow("no expiry 2028-01-21 for AAPL");
  // A provider that hands back its nearest expiry for an unlisted date has not answered the request.
  await expect(options.execute(["AAPL", "--expiration", "2028-01-21"], expiryProvider([EXPIRIES[0]!]).cli.context))
    .rejects.toThrow("no expiry 2028-01-21 for AAPL");
});
