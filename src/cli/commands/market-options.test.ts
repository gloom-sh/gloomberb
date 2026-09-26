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
