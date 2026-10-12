import { describe, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { WriteThroughResourceStore } from "../data/memory-resource-store";
import type { CachedResourceRecord } from "../data/resource-store";
import { createTestBrokerAdapter } from "../test-support/broker";
import { createMarginAccount } from "../test-support/margin-account";
import type { BrokerInstanceConfig } from "../types/config";
import {
  deleteBrokerAccountRecord,
  isBrokerAccountSnapshotKey,
  listPersistedBrokerAccountRecords,
  loadPersistedBrokerAccountMap,
  persistBrokerAccounts,
  saveBrokerAccountRecord,
} from "./account-cache";

describe("broker account snapshots without a cache database", () => {
  const instance: BrokerInstanceConfig = {
    id: "signed-in-test", brokerType: "signed-in", label: "Test broker", config: { broker: "test" }, enabled: true,
  };
  const broker = createTestBrokerAdapter({ id: "signed-in", listAccounts: async () => [] });
  const brokers = new Map([["signed-in", broker]]);

  test("the desktop view's snapshot reaches the cache database and is there after a restart", () => {
    const database = new AppPersistence(":memory:");
    try {
      // The view's store, its writes crossing the process boundary as JSON.
      let sent: CachedResourceRecord | null = null;
      const viewStore = (saved: CachedResourceRecord[]) => new WriteThroughResourceStore(saved, {
        set: (record) => {
          sent = record;
          saveBrokerAccountRecord(database.resources, JSON.parse(JSON.stringify(record)));
        },
        delete: (key) => deleteBrokerAccountRecord(database.resources, key),
      }, isBrokerAccountSnapshotKey);

      const account = createMarginAccount({ updatedAt: 1_700_000_000_000 });
      const first = viewStore([]);
      persistBrokerAccounts(first, instance, broker, [account]);
      first.set({ namespace: "plugin:signed-in", kind: "quote", entityKey: "AAA" }, { price: 1 }, {
        cachePolicy: { staleMs: 1_000, expireMs: 1_000 },
      });
      const [saved, ...rest] = listPersistedBrokerAccountRecords(database.resources, [instance]);
      expect(rest).toEqual([]);
      expect(database.resources.get({ namespace: "plugin:signed-in", kind: "quote", entityKey: "AAA" })).toBeNull();

      const restarted = viewStore(listPersistedBrokerAccountRecords(database.resources, [instance]));
      expect(loadPersistedBrokerAccountMap(restarted, [instance], brokers)).toEqual({ [instance.id]: [account] });
      // Saved with the view's own times, so it ages from when the broker answered.
      expect([saved?.fetchedAt, saved?.staleAt, saved?.expiresAt]).toEqual([sent!.fetchedAt, sent!.staleAt, sent!.expiresAt]);

      expect(saveBrokerAccountRecord(database.resources, { ...saved!, kind: "quote" })).toBe(false);
    } finally {
      database.close();
    }
  });
});
