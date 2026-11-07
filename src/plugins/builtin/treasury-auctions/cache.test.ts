import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { PluginPersistence } from "../../../types/plugin";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { AUCTION_ARCHIVE_PAGE_SIZE, auctionArchiveBoundary, fetchAuctionPages, type AuctionQuery } from "./client";
import {
  attachTreasuryAuctionsPersistence,
  CACHE_SCHEMA_VERSION,
  loadTreasuryAuctions,
  resetTreasuryAuctionsPersistence,
  TREASURY_DIRECT_CONNECTION_ID,
  TREASURY_FISCAL_DATA_CONNECTION_ID,
} from "./cache";
import { isPendingAuction } from "./model";
import { auction, RECORDED_NOW, recordedFiscalData, recordedTreasuryDirect } from "./test-fixture";
import { ApiRequestError } from "../../../api-client/errors";
import { outage } from "../../../test-support/outage";
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
  // An invalid page is a reply that fails validation: the error, never covered by the saved board.
  test("incomplete pagination cannot overwrite a known board or lose its failure on the next read", async () => {
    const { persistence, writes } = fakePersistence();
    attachTreasuryAuctionsPersistence(persistence);
    await loadTreasuryAuctions(false, async () => [auctionFixture("known")]);
    await expect(loadTreasuryAuctions(true, () => fetchAuctionPages(async (page) => page === 1
      ? { data: [{ security_type: "Note", security_term: "2-Year", auction_date: "2026-09-10" }], meta: { "total-pages": 2 } }
      : { error: "Invalid page envelope" }))).rejects.toThrow("page 2");
    await expect(loadTreasuryAuctions(false, async () => { throw new Error("Fresh cached read must not fetch"); })).rejects.toThrow("page 2");
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
      sourceKey: "treasury-fiscal-data", schemaVersion: CACHE_SCHEMA_VERSION,
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
      throw new ApiRequestError("Treasury Fiscal Data request failed (503)", 503);
    });

    expect(result.auctions[0]!.id).toBe("expired");
    expect(result.stale).toBe(true);
    expect(result.savedAt).toBe(1_000);
    // A refusal is said, saved board or not.
    await expect(loadTreasuryAuctions(true, async () => { throw new ApiRequestError("Treasury Fiscal Data request failed (404)", 404); }))
      .rejects.toThrow("(404)");
  });

  test("propagates the failure when there is nothing cached to fall back to", async () => {
    const { persistence } = fakePersistence();
    attachTreasuryAuctionsPersistence(persistence);

    await expect(loadTreasuryAuctions(true, async () => {
      throw new Error("503");
    })).rejects.toThrow("503");
  });

  test("an empty payload is an error and never replaces the cached board", async () => {
    const { persistence, writes } = fakePersistence({ value: [auctionFixture("cached")], stale: true, expired: false });
    attachTreasuryAuctionsPersistence(persistence);

    await expect(loadTreasuryAuctions(true, async () => [])).rejects.toThrow("returned no auctions");
    expect(writes).toHaveLength(0);
    expect((await loadTreasuryAuctions(true, async () => { throw outage(); })).auctions[0]!.id).toBe("cached");
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

  test("ALL joins the recent side and the archive, and a refresh leaves the archive alone", async () => {
    const persistence = new MemoryPluginPersistence();
    attachTreasuryAuctionsPersistence(persistence);
    const queries: AuctionQuery[] = [];
    const loader = async (query: AuctionQuery) => {
      queries.push(query);
      // The board on the boundary day comes back from both walks once.
      return query.before ? [auctionFixture("boundary"), auctionFixture("1979")] : [auctionFixture("recent"), auctionFixture("boundary")];
    };
    const boundary = auctionArchiveBoundary();
    const all = await loadTreasuryAuctions(false, loader, "all");
    expect(all.auctions.map((auction) => auction.id)).toEqual(["recent", "boundary", "1979"]);
    expect(queries).toEqual(expect.arrayContaining([
      { from: boundary },
      { from: "1979-10-31", before: boundary, pageSize: AUCTION_ARCHIVE_PAGE_SIZE },
    ]));
    await loadTreasuryAuctions(true, loader, "all");
    expect(queries.slice(2)).toEqual([{ from: boundary }]);
  });

  test("works with no persistence attached at all", async () => {
    const result = await loadTreasuryAuctions(true, async () => [auctionFixture("network")]);
    expect(result.auctions[0]!.id).toBe("network");
  });
});

describe("loadTreasuryAuctions with TreasuryDirect", () => {
  beforeEach(() => setSystemTime(new Date(RECORDED_NOW)));
  afterEach(() => setSystemTime());

  const fiscalLoader = async () => recordedFiscalData();
  const directLoader = async () => recordedTreasuryDirect();
  /** Fiscal Data's board as an earlier read saved it: stale, so a refresh is due, and kept for a week. */
  const savedFiscalBoard = () => {
    const persistence = new MemoryPluginPersistence();
    persistence.seedResource("treasury-auctions", "recent:120", recordedFiscalData(), {
      sourceKey: "treasury-fiscal-data", schemaVersion: CACHE_SCHEMA_VERSION, stale: true,
    });
    return persistence;
  };
  const rate = (board: TreasuryAuction[], cusip: string) => board.find((entry) => entry.cusip === cusip)?.highYield
    ?? board.find((entry) => entry.cusip === cusip)?.highInvestmentRate ?? null;

  test("fills the results and the auctions Fiscal Data lags on, and lists the announced ones", async () => {
    attachTreasuryAuctionsPersistence(new MemoryPluginPersistence());
    const { auctions, refreshError, stale } = await loadTreasuryAuctions(true, fiscalLoader, 120, directLoader);

    const ids = auctions.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set([...recordedFiscalData(), ...recordedTreasuryDirect()].map((entry) => entry.id)));
    // 19 to 22 Oct read Pending on Fiscal Data's board; they carry their results now.
    const lagged = auctions.filter((entry) => entry.auctionDate >= "2026-10-19" && entry.auctionDate <= "2026-10-22");
    expect(lagged.length).toBeGreaterThanOrEqual(8);
    expect(lagged.filter(isPendingAuction)).toEqual([]);
    expect(rate(auctions, "91282CRR4")).toBe(2.367);
    // The newest results are TreasuryDirect's, the pending ones are the auctions announced after them.
    expect(auctions.filter((entry) => entry.auctionDate === "2026-11-05").length).toBe(2);
    expect(auctions.filter(isPendingAuction).map((entry) => entry.auctionDate).every((day) => day > "2026-11-05")).toBe(true);
    expect(auctions.filter(isPendingAuction).length).toBe(6);
    expect(refreshError).toBeUndefined();
    expect(stale).toBe(false);
  });

  test("both sources keep their cache and each is read once per refresh, TreasuryDirect for at most 60 days", async () => {
    attachTreasuryAuctionsPersistence(new MemoryPluginPersistence());
    const asked: string[] = [];
    const fiscal = async (query: AuctionQuery) => { asked.push(`fiscal from ${query.from}`); return recordedFiscalData(); };
    const direct = async (days: number) => { asked.push(`direct ${days}`); return recordedTreasuryDirect(); };

    await loadTreasuryAuctions(false, fiscal, 120, direct);
    await loadTreasuryAuctions(false, fiscal, 120, direct);
    expect(asked).toEqual(["fiscal from 2026-07-09", "direct 60"]);
    // A shorter window reads its own board of Fiscal Data's and no more of TreasuryDirect's than it shows.
    const short = await loadTreasuryAuctions(false, fiscal, 30, direct);
    expect(asked.slice(2)).toEqual(["fiscal from 2026-10-07", "direct 30"]);
    expect(short.auctions.every((entry) => entry.auctionDate >= "2026-10-07")).toBe(true);
    await loadTreasuryAuctions(true, fiscal, 120, direct);
    expect(asked.slice(4)).toEqual(["fiscal from 2026-07-09", "direct 60"]);
  });

  test("a board from Fiscal Data alone is served when TreasuryDirect is down, and says so", async () => {
    attachTreasuryAuctionsPersistence(new MemoryPluginPersistence());
    for (const failure of [new ApiRequestError("TreasuryDirect request failed (503)", 503), new ApiRequestError("TreasuryDirect request failed (404)", 404), outage()]) {
      const result = await loadTreasuryAuctions(true, fiscalLoader, 120, async () => { throw failure; });
      expect(result.auctions.map((entry) => entry.id)).toEqual(recordedFiscalData().map((entry) => entry.id));
      expect(result.refreshError).toBe(failure.message);
      expect(result.stale).toBe(true);
    }
    // An empty answer is a failure, not a quiet month.
    const empty = await loadTreasuryAuctions(true, fiscalLoader, 120, async () => []);
    expect(empty.auctions).toHaveLength(recordedFiscalData().length);
    expect(empty.refreshError).toBe("TreasuryDirect returned no auctions");
  });

  test("a board from TreasuryDirect alone is served when Fiscal Data is down", async () => {
    attachTreasuryAuctionsPersistence(new MemoryPluginPersistence());
    for (const failure of [new ApiRequestError("Treasury Fiscal Data request failed (503)", 503), new ApiRequestError("Treasury Fiscal Data request failed (404)", 404)]) {
      const result = await loadTreasuryAuctions(true, async () => { throw failure; }, 120, directLoader);
      expect(result.auctions.map((entry) => entry.id)).toEqual(recordedTreasuryDirect().map((entry) => entry.id));
      expect(result.refreshError).toBe(failure.message);
      expect(result.savedAt).toBeUndefined();
    }
    // Fiscal Data answering with nothing is down as well.
    expect((await loadTreasuryAuctions(true, async () => [], 120, directLoader)).refreshError).toBe("Treasury Fiscal Data returned no auctions");
  });

  test("a saved Fiscal Data board takes the results TreasuryDirect has while Fiscal Data is down", async () => {
    attachTreasuryAuctionsPersistence(savedFiscalBoard());
    const result = await loadTreasuryAuctions(false, async () => { throw outage(); }, 120, directLoader);
    expect(result.auctions.filter(isPendingAuction).every((entry) => entry.auctionDate > "2026-11-05")).toBe(true);
    expect(result.auctions.some((entry) => entry.auctionDate === "2026-11-05")).toBe(true);
    // The footer says how old the saved board is, not that the refresh failed.
    expect(result.stale).toBe(true);
    expect(result.savedAt).toBeDefined();
  });

  test("with both sources down the failure is Fiscal Data's, and a saved board answers for a transient one", async () => {
    attachTreasuryAuctionsPersistence(new MemoryPluginPersistence());
    await expect(loadTreasuryAuctions(true, async () => { throw new Error("fiscal"); }, 120, async () => { throw new Error("direct"); }))
      .rejects.toThrow("fiscal");

    attachTreasuryAuctionsPersistence(savedFiscalBoard());
    const result = await loadTreasuryAuctions(false, async () => { throw outage(); }, 120, async () => { throw outage(); });
    expect(result.auctions).toHaveLength(recordedFiscalData().length);
    expect(result.savedAt).toBeDefined();
  });

  test("ALL adds TreasuryDirect to its recent side only; the archive is Fiscal Data's alone", async () => {
    attachTreasuryAuctionsPersistence(new MemoryPluginPersistence());
    const queries: AuctionQuery[] = [];
    const directDays: number[] = [];
    const result = await loadTreasuryAuctions(true, async (query) => {
      queries.push(query);
      return query.before ? [auction({ id: "1979", secType: "Bond", securityTerm: "20-Year", auctionDate: "1979-10-31", highYield: 9.5 })] : recordedFiscalData();
    }, "all", async (days) => { directDays.push(days); return recordedTreasuryDirect(); });
    expect(directDays).toEqual([60]);
    expect(queries).toHaveLength(2);
    expect(result.auctions.some((entry) => entry.id === "1979")).toBe(true);
    expect(result.auctions.filter(isPendingAuction).every((entry) => entry.auctionDate > "2026-11-05")).toBe(true);
    expect(result.auctions).toHaveLength(new Set([...recordedFiscalData(), ...recordedTreasuryDirect()].map((entry) => entry.id)).size + 1);
  });

  test("reports both sources through Connections", async () => {
    const health = new ConnectionHealthRegistry();
    health.registerSource({ id: TREASURY_FISCAL_DATA_CONNECTION_ID, name: "Treasury Fiscal Data", kind: "api" });
    health.registerSource({ id: TREASURY_DIRECT_CONNECTION_ID, name: "TreasuryDirect", kind: "api" });
    attachTreasuryAuctionsPersistence(new MemoryPluginPersistence(), health);
    await loadTreasuryAuctions(true, fiscalLoader, 120, async () => { throw outage(); });
    const status = Object.fromEntries(health.getSnapshot().sources.map((source) => [source.id, source.status]));
    expect(status[TREASURY_FISCAL_DATA_CONNECTION_ID]).toBe("connected");
    expect(status[TREASURY_DIRECT_CONNECTION_ID]).not.toBe("connected");
  });
});
