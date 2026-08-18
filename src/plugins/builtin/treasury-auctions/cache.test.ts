import { afterEach, describe, expect, test } from "bun:test";
import type { PluginPersistence } from "../../../types/plugin";
import {
  attachTreasuryAuctionsPersistence,
  loadTreasuryAuctions,
  resetTreasuryAuctionsPersistence,
} from "./cache";
import type { TreasuryAuction } from "./types";

function auctionFixture(id: string): TreasuryAuction {
  return {
    id,
    secType: "Note",
    securityTerm: "10-Year",
    auctionDate: "2026-08-12",
    highInvestmentRate: null,
    highYield: 4.683,
    avgMedYield: null,
    highPrice: null,
    lowPrice: null,
    avgMedPrice: null,
    bidToCoverRatio: 2.53,
    competitiveAccepted: null,
    indirectAccepted: null,
    primaryDealerAccepted: null,
    totalAccepted: null,
    offeringAmount: null,
  };
}

/** Minimal stand-in for the resource cache: one slot, explicit stale/expiry. */
function fakePersistence(seed?: { value: TreasuryAuction[]; stale: boolean; expired: boolean }) {
  const writes: TreasuryAuction[][] = [];
  let stored = seed ? { value: seed.value, fetchedAt: 1_000, stale: seed.stale, expired: seed.expired } : null;
  const persistence = {
    getResource: (_kind: string, _key: string, options?: { allowExpired?: boolean }) => {
      if (!stored) return null;
      if (stored.expired && !options?.allowExpired) return null;
      return { value: stored.value, fetchedAt: stored.fetchedAt, stale: stored.stale };
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

  test("works with no persistence attached at all", async () => {
    const result = await loadTreasuryAuctions(true, async () => [auctionFixture("network")]);
    expect(result.auctions[0]!.id).toBe("network");
  });
});
