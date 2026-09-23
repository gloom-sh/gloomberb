import { expect, setSystemTime, test } from "bun:test";
import type { CliCommandContext } from "../../types/plugin";
import { marketDataCliCommands } from "./market";

const options = marketDataCliCommands.find((command) => command.name === "options")!;

function cliContext(chain: object, stored: number, refreshError: unknown, printed: { warnings?: string[] }[]) {
  return {
    initMarketData: async () => ({
      persistence: { close: () => {} },
      dataProvider: { getCachedQuery: () => ({ load: async () => ({
        value: chain, fetchedAt: stored, staleAt: stored, expiresAt: Infinity, source: "cloud", refreshError,
      }) }) },
    }),
    cliOptions: { refresh: true },
    printResult: (result: { warnings?: string[] }) => { printed.push(result); },
    fail: (message: string): never => { throw new Error(message); },
  } as unknown as CliCommandContext;
}

test("options reports when a failed refresh falls back to a stored chain", async () => {
  const stored = Date.parse("2026-09-22T19:55:00Z");
  const chain = { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [] };
  const printed: { warnings?: string[] }[] = [];
  await options.execute(["AAPL"], cliContext(chain, stored, new Error("429"), printed));
  expect(printed[0]!.warnings).toHaveLength(1);
  expect(printed[0]!.warnings![0]).toContain("2026-09-22T19:55:00.000Z");
});

test("options flags a chain last observed before today's US open", async () => {
  // 09:45 New York: the delayed chain may still be yesterday's closing snapshot.
  setSystemTime(new Date("2026-09-23T13:45:00Z"));
  try {
    const printed: { warnings?: string[] }[] = [];
    for (const asOf of ["2026-09-22T19:59:59Z", "2026-09-23T13:31:00Z"]) {
      const chain = { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [], asOf };
      await options.execute(["AAPL"], cliContext(chain, Date.now(), undefined, printed));
    }
    expect(printed[0]!.warnings).toEqual(["No option trades this session yet (last trade 2026-09-22T19:59:59Z)"]);
    expect(printed[1]!.warnings).toBeUndefined();
  } finally {
    setSystemTime();
  }
});
