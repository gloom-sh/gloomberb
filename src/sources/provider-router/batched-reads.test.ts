import { expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import type { BatchedReadMethod, DataProvider } from "../../types/data-provider";
import { fallbackProvider } from "../../test-support/data-provider";
import { AssetDataRouter } from "./index";
import { attachTestRegistry, brokerInstance, setBrokerInstances } from "./test-support";

// A pane asks many reads at once only when they go out in batches; a broker reading them one by one must not get them all.
test("the router batches a read only when every source that could answer it does, a connected broker included", () => {
  const cloud: DataProvider = { ...fallbackProvider, id: "gloom", getOptionsChain: async () => ({ underlyingSymbol: "X", expirationDates: [], calls: [], puts: [] }),
    batchesReads: (method: BatchedReadMethod) => method === "getPriceHistory" || method === "getOptionsChain" };
  const store = new AppPersistence(":memory:");
  try {
    const router = new AssetDataRouter(cloud, [], store.resources);
    attachTestRegistry(router, { brokers: [["ibkr", {
      id: "ibkr", name: "Test broker", configSchema: [], validate: async () => true, importPositions: async () => [],
      getPriceHistory: async () => [],
    }]] });
    expect([router.batchesReads("getPriceHistory"), router.batchesReads("getOptionsChain")]).toEqual([true, true]);
    // A connected broker reads history one request at a time, and is asked before the cloud; it reads no options.
    setBrokerInstances(router, [brokerInstance()]);
    expect([router.batchesReads("getPriceHistory"), router.batchesReads("getOptionsChain")]).toEqual([false, true]);
    // A source that does not batch.
    const plain = new AssetDataRouter({ ...fallbackProvider, id: "plain" }, [], store.resources);
    expect(plain.batchesReads("getPriceHistory")).toBe(false);
  } finally {
    store.close();
  }
});
