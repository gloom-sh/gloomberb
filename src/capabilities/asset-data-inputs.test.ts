import { expect, test } from "bun:test";
import { assetDataProvider } from "./factories";
import { CapabilityRegistry } from "./registry";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";

function registryWith(provider = createTestDataProvider()) {
  const registry = new CapabilityRegistry();
  registry.register("core", assetDataProvider({ ...provider, id: "asset-data-router" }));
  return registry;
}

// `api invoke asset-data.asset-data-router.getQuote '{"symbol":"TTEK"}'` failed with
// "undefined is not an object (evaluating 'value.trim')", and an unknown range read one year.
test("an asset-data operation names the input it takes when a field is missing or of the wrong kind", async () => {
  const asked: Array<[string, string | undefined]> = [];
  const registry = registryWith(createTestDataProvider({
    getQuote: async (ticker, exchange) => {
      asked.push([ticker, exchange]);
      return createTestQuote({ symbol: ticker });
    },
    getPriceHistoryWithMetadata: async () => ({ points: [] }),
    getDetailedPriceHistoryWithMetadata: async (_ticker, _exchange, start, end) => ({ points: [{ date: start, close: 1 }, { date: end, close: 2 }] }),
  }));
  const invoke = (operation: string, payload: unknown) => registry.invoke("asset-data.asset-data-router", operation, payload);

  await expect(invoke("getQuote", { symbol: "TTEK" }))
    .rejects.toThrow("getQuote takes { ticker: string, exchange?: string, context?: object }: ticker is missing (it got symbol).");
  await expect(invoke("getQuote", { ticker: 7 })).rejects.toThrow("ticker is a string, not 7.");
  await expect(invoke("getPriceHistoryWithMetadata", { ticker: "KO", range: "20Y" }))
    .rejects.toThrow("range is one of 1D, 1W, 1M, 3M, 6M, 1Y, 5Y, ALL, not \"20Y\".");
  expect(asked).toEqual([]);

  expect((await invoke("getQuote", { ticker: "TTEK" }) as { symbol: string }).symbol).toBe("TTEK");
  expect(asked).toEqual([["TTEK", undefined]]);
  // Dates come as JSON carries them, ISO strings or epoch ms, and reach the source as dates.
  const history = await invoke("getDetailedPriceHistoryWithMetadata", {
    ticker: "KO", startDate: "1990-01-02", endDate: Date.UTC(1990, 0, 3), barSize: "1d",
  }) as { points: Array<{ date: Date }> };
  expect(history.points.map((point) => point.date.toISOString().slice(0, 10))).toEqual(["1990-01-02", "1990-01-03"]);

  const manifest = registry.manifests().find((entry) => entry.id === "asset-data.asset-data-router")!;
  expect(manifest.operations.find((operation) => operation.id === "getQuote")?.inputShape)
    .toBe("{ ticker: string, exchange?: string, context?: object }");
});
