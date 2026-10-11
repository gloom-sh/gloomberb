import { afterEach, describe, expect, test } from "bun:test";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginPersistence } from "../../../types/plugin";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { fetchAuctionPages } from "./client";
import {
  attachTreasuryAuctionsPersistence,
  loadTreasuryAuctions,
  resetTreasuryAuctionsPersistence,
  TREASURY_FISCAL_DATA_CONNECTION_ID,
} from "./cache";
import { auction } from "./test-fixture";
import type { TreasuryAuction } from "./types";

function auctionFixture(id: string): TreasuryAuction {
  return auction({ id, secType: "Note", securityTerm: "10-Year", highYield: 4.683, bidToCoverRatio: 2.53 });
}

/** Minimal stand-in for the resource cache: one slot, explicit stale/expiry. */
function fakePersistence(seed?: { value: TreasuryAuction[]; stale: boolean; expired: boolean }) {
  const writes: TreasuryAuction[][] = [];
  let stored = seed ? { value: seed.value, fetchedAt: 1_000, stale: seed.stale, expired: seed.expired } : null;
  const persistence = {
    getResource: (_kind: string, _key: string, options?: { allowExpired?: boolean }) => {
      if (!stored) return null;
      if (stored.expired && !options?.allowExpired) return null;
      return { value: stored.value, fetchedAt: stored.fetchedAt, stale: stored.stale,
        staleAt: stored.stale ? 0 : Date.now() + 60_000, expiresAt: stored.expired ? 0 : Date.now() + 60_000 };
    },
    setResource: (_kind: string, _key: string, value: TreasuryAuction[]) => {
      writes.push(value);
      stored = { value, fetchedAt: Date.now(), stale: false, expired: false };
      return { value, fetchedAt: Date.now(), stale: false };
    },
  } as unknown as PluginPersistence;
  return { persistence, writes };
}

afterEach(() => {
  resetTreasuryAuctionsPersistence();
});

describe("loadTreasuryAuctions", () => {
  test("incomplete pagination cannot overwrite a known board or lose its failure on the next read", async () => {
    const { persistence, writes } = fakePersistence();
    attachTreasuryAuctionsPersistence(persistence);
    const original = await loadTreasuryAuctions(false, async () => [auctionFixture("known")]);
    const failed = await loadTreasuryAuctions(true, () => fetchAuctionPages(async (page) => page === 1
      ? { data: [{ security_type: "Note", security_term: "2-Year", auction_date: "2026-09-10" }], meta: { "total-pages": 2 } }
      : { error: "Invalid page envelope" }));
    const read = await loadTreasuryAuctions(false, async () => { throw new Error("Fresh cached read must not fetch"); });
    for (const result of [failed, read]) {
      expect(result.auctions).toEqual(original.auctions);
      expect(result.fetchedAt).toBe(original.fetchedAt);
      expect(result.stale).toBe(true);
      expect(result.refreshError).toContain("page 2");
    }
    expect(writes).toHaveLength(1);
    const recovered = await loadTreasuryAuctions(true, async () => [auctionFixture("recovered")]);
    expect(recovered.stale).toBe(false);
    expect(recovered.refreshError).toBeUndefined();
    expect((await loadTreasuryAuctions(false)).auctions[0]?.id).toBe("recovered");
  });

  test("legacy potentially truncated history is replaced while a validated cached board remains usable", async () => {
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("treasury-auctions", "recent:120", [auctionFixture("legacy")], {
      sourceKey: "treasury-fiscal-data", schemaVersion: 2,
    });
    persistence.seedResource("treasury-auctions", "recent:30", [auctionFixture("current")], {
      sourceKey: "treasury-fiscal-data", schemaVersion: 4,
    });
    attachTreasuryAuctionsPersistence(persistence);
    let calls = 0;
    const loader = async () => { calls++; return [auctionFixture("complete")]; };
    const replaced = await loadTreasuryAuctions(false, loader, 120);
    const current = await loadTreasuryAuctions(false, loader, 30);
    expect(replaced.auctions[0]?.id).toBe("complete");
    expect(current.auctions[0]?.id).toBe("current");
    expect(calls).toBe(1);
  });

  test("serves fresh cache without hitting the network", async () => {
    const { persistence } = fakePersistence({ value: [auctionFixture("cached")], stale: false, expired: false });
    attachTreasuryAuctionsPersistence(persistence);
    let calls = 0;

    const result = await loadTreasuryAuctions(false, async () => {
      calls += 1;
      return [auctionFixture("network")];
    });

    expect(calls).toBe(0);
    expect(result.auctions[0]!.id).toBe("cached");
    expect(result.stale).toBe(false);
  });

  test("refetches once the entry is stale and caches the result", async () => {
    const { persistence, writes } = fakePersistence({ value: [auctionFixture("cached")], stale: true, expired: false });
    attachTreasuryAuctionsPersistence(persistence);

    const result = await loadTreasuryAuctions(false, async () => [auctionFixture("network")]);

    expect(result.auctions[0]!.id).toBe("network");
    expect(result.stale).toBe(false);
    expect(writes).toHaveLength(1);
  });

  test("falls back to expired cache when the endpoint fails", async () => {
    const { persistence } = fakePersistence({ value: [auctionFixture("expired")], stale: true, expired: true });
    attachTreasuryAuctionsPersistence(persistence);

    const result = await loadTreasuryAuctions(true, async () => {
      throw new Error("503");
    });

    expect(result.auctions[0]!.id).toBe("expired");
    expect(result.stale).toBe(true);
  });

  test("propagates the failure when there is nothing cached to fall back to", async () => {
    const { persistence } = fakePersistence();
    attachTreasuryAuctionsPersistence(persistence);

    await expect(loadTreasuryAuctions(true, async () => {
      throw new Error("503");
    })).rejects.toThrow("503");
  });

  test("keeps the cached board when a refresh returns an empty payload", async () => {
    const { persistence, writes } = fakePersistence({ value: [auctionFixture("cached")], stale: true, expired: false });
    attachTreasuryAuctionsPersistence(persistence);

    const result = await loadTreasuryAuctions(true, async () => []);

    expect(result.auctions[0]!.id).toBe("cached");
    expect(result.stale).toBe(true);
    expect(writes).toHaveLength(0);
  });

  test("never caches an empty payload, so the next load can still recover", async () => {
    const { persistence, writes } = fakePersistence();
    attachTreasuryAuctionsPersistence(persistence);

    // Nothing to fall back on: an empty window is a failure, not "no auctions".
    await expect(loadTreasuryAuctions(true, async () => [])).rejects.toThrow(/no auctions/);
    expect(writes).toHaveLength(0);

    const recovered = await loadTreasuryAuctions(false, async () => [auctionFixture("network")]);
    expect(recovered.auctions[0]!.id).toBe("network");
    expect(recovered.stale).toBe(false);
    expect(writes).toHaveLength(1);
  });

  test("shares one in-flight fetch across concurrent callers", async () => {
    const { persistence } = fakePersistence();
    attachTreasuryAuctionsPersistence(persistence);
    let calls = 0;

    const [first, second] = await Promise.all([
      loadTreasuryAuctions(true, async () => {
        calls += 1;
        return [auctionFixture("network")];
      }),
      loadTreasuryAuctions(true, async () => {
        calls += 1;
        return [auctionFixture("other")];
      }),
    ]);

    expect(calls).toBe(1);
    expect(first.auctions[0]!.id).toBe("network");
    expect(second.auctions[0]!.id).toBe("network");
  });

  test("reports real Fiscal Data requests through Connections", async () => {
    const { persistence } = fakePersistence();
    const health = new ConnectionHealthRegistry();
    health.registerSource({
      id: TREASURY_FISCAL_DATA_CONNECTION_ID,
      name: "Treasury Fiscal Data",
      kind: "api",
    });
    attachTreasuryAuctionsPersistence(persistence, health);

    await loadTreasuryAuctions(true, async () => [auctionFixture("network")]);

    expect(health.getSnapshot().sources[0]).toMatchObject({
      id: TREASURY_FISCAL_DATA_CONNECTION_ID,
      status: "connected",
      lastOperation: "fetchAuctions",
    });
  });

  test("works with no persistence attached at all", async () => {
    const result = await loadTreasuryAuctions(true, async () => [auctionFixture("network")]);
    expect(result.auctions[0]!.id).toBe("network");
  });
});
