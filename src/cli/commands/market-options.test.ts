import { expect, test } from "bun:test";
import type { CliCommandContext } from "../../types/plugin";
import { marketDataCliCommands } from "./market";

const options = marketDataCliCommands.find((command) => command.name === "options")!;

test("options --refresh forces the chain and a stored fallback is reported", async () => {
  const stored = Date.parse("2026-09-22T19:55:00Z");
  const chain = { underlyingSymbol: "AAPL", expirationDates: [1], calls: [], puts: [], asOf: "2026-09-22T19:39:21.000Z" };
  const loads: unknown[] = [];
  const printed: { warnings?: string[] }[] = [];
  const context = {
    initMarketData: async () => ({
      persistence: { close: () => {} },
      dataProvider: { getCachedQuery: () => ({ load: async (request: unknown) => {
        loads.push(request);
        return { value: chain, fetchedAt: stored, staleAt: stored, expiresAt: Infinity, source: "cloud", refreshError: new Error("429") };
      } }) },
    }),
    cliOptions: { refresh: true },
    printResult: (result: { warnings?: string[] }) => { printed.push(result); },
    fail: (message: string): never => { throw new Error(message); },
  } as unknown as CliCommandContext;
  await options.execute(["AAPL"], context);
  expect(loads).toEqual([{ force: true }]);
  expect(printed[0]!.warnings).toEqual([
    "Options refresh failed; showing the chain stored 2026-09-22T19:55:00.000Z (last trade 2026-09-22T19:39:21.000Z)",
  ]);
});
