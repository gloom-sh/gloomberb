import { describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { GpuBoardPayload, GpuHistoryPayload, GpuHistoryQuery } from "../../../api-client/gpu";
import { fetchGpuBoard, fetchGpuEvents, fetchGpuHistory, gpuCacheScope, getCachedGpuBoard, gpuBoardCache, GPU_NOT_AVAILABLE, loadGpuBoard } from "./client";
import { gpuBoard, gpuEvent, gpuRow } from "./test-fixture";

describe("GPU API boundary", () => {
  test("missing routes and uncollected prices are unavailable while failures retain their cause", async () => {
    for (const status of [404, 503]) {
      await expect(fetchGpuBoard({ getCloudGpuBoard: async () => { throw new ApiRequestError("Not Found", status); } }))
        .rejects.toThrow(GPU_NOT_AVAILABLE);
    }
    for (const payload of [gpuBoard({ status: "unavailable" }), gpuBoard({ rows: [] })]) {
      await expect(fetchGpuBoard({ getCloudGpuBoard: async () => payload })).rejects.toThrow(GPU_NOT_AVAILABLE);
    }
    for (const error of [new ApiRequestError("Sign in required", 401), new ApiRequestError("Bad gateway", 502), new Error("Network failed")]) {
      await expect(fetchGpuBoard({ getCloudGpuBoard: async () => { throw error; } })).rejects.toBe(error);
    }
  });

  test("missing returns remain null and a bad row or duplicate series refuses the whole board", async () => {
    const good = gpuBoard();
    const accepted = await fetchGpuBoard({ getCloudGpuBoard: async () => good });
    expect([accepted.rows[0]!.change1d, accepted.rows[0]!.change7d, accepted.rows[0]!.change30d]).toEqual([null, null, null]);
    const malformed: unknown[] = [
      null,
      gpuBoard({ rows: [gpuRow(), gpuRow()] }),
      gpuBoard({ rows: [gpuRow({ id: "different-series" })] }),
      ...[0, -1, Number.NaN, Infinity, null].map((price) => ({ ...good, rows: [{ ...gpuRow(), pricePerGpuHr: price }] })),
      gpuBoard({ rows: [gpuRow({ change7d: Number.NaN })] }),
      gpuBoard({ rows: [gpuRow({ stats: { n: 8, min: 4, max: 3 } })] }),
      gpuBoard({ rows: [gpuRow({ stats: { n: 8, min: 1, max: 4, p25: 3, p75: 2 } })] }),
      gpuBoard({ rows: [gpuRow({ observedAt: "not-a-date" })] }),
    ];
    for (const payload of malformed) {
      await expect(fetchGpuBoard({ getCloudGpuBoard: async () => payload as GpuBoardPayload }))
        .rejects.toThrow("invalid GPU rental prices");
    }
  });

  test("provider effective dates remain separate and either history array rejects a different requested series", async () => {
    const selected = gpuRow();
    const observation = gpuRow({ effectiveAt: "2026-09-01T00:00:00.000Z" });
    const effectivePoint = gpuRow({ observedAt: "2026-10-03T19:00:00.000Z", effectiveAt: "2025-01-01T00:00:00.000Z" });
    const payload: GpuHistoryPayload = { generatedAt: "2026-10-03T19:01:00.000Z", points: [observation], effectivePoints: [effectivePoint] };
    const result = await fetchGpuHistory({ seriesId: selected.id }, { getCloudGpuHistory: async () => payload });
    expect(result.points).toEqual([observation]);
    expect(result.effectivePoints).toEqual([effectivePoint]);

    const mismatches: Array<[GpuHistoryQuery, ReturnType<typeof gpuRow>]> = [
      [{ seriesId: selected.id }, gpuRow({ skuKey: "h100-pcie-80", formFactor: "PCIe" })],
      [{ gpuModel: "H100" }, gpuRow({ gpuModel: "H200" })],
      [{ basis: "list" }, gpuRow({ basis: "spot" })],
    ];
    for (const [query, other] of mismatches) {
      for (const field of ["points", "effectivePoints"] as const) {
        await expect(fetchGpuHistory(query, { getCloudGpuHistory: async () => ({ ...payload, [field]: [other] }) }))
          .rejects.toThrow("different GPU series");
      }
    }
  });
});

test("a refresh failure keeps a marked last-good board while access refusal still requires signing in", async () => {
  gpuBoardCache.reset();
  const saved = gpuBoard();
  await gpuBoardCache.load(`${gpuCacheScope()}:board`, async () => saved);
  const request = spyOn(apiClient, "getCloudGpuBoard").mockRejectedValue(new ApiRequestError("Bad gateway", 502));
  try {
    expect(getCachedGpuBoard()).toEqual({ payload: saved, stale: false, refreshError: null });
    const fallback = await loadGpuBoard(true);
    expect(fallback).toEqual({ payload: saved, stale: true, refreshError: "Bad gateway" });
    expect(saved.stale).toBe(false);

    const refused = new ApiRequestError("Session expired", 401);
    request.mockRejectedValue(refused);
    await expect(loadGpuBoard(true)).rejects.toBe(refused);
  } finally {
    request.mockRestore();
    gpuBoardCache.reset();
  }
});


test("history and availability events retain source evidence and reject malformed provenance", async () => {
  const point = gpuRow({ provenance: "archive", provenanceLabel: "archived page, reconstructed", sourceUrl: "https://example.com/prices", evidenceUrl: "https://web.archive.org/web/20240101id_/https://example.com/prices" });
  const payload = { generatedAt: point.observedAt, points: [point], effectivePoints: [], access: { tier: "pro" as const, preview: false, locked: false } };
  expect(await fetchGpuHistory({}, { getCloudGpuHistory: async () => payload })).toEqual(payload);
  for (const bad of [{ provenance: "estimated" }, { evidenceUrl: "javascript:alert(1)" }, { access: true }]) {
    const malformed = "access" in bad ? { ...payload, access: bad.access } : { ...payload, points: [{ ...point, ...bad }] };
    await expect(fetchGpuHistory({}, { getCloudGpuHistory: async () => malformed as GpuHistoryPayload })).rejects.toThrow("invalid GPU price history");
  }
  const event = gpuEvent({ kind: "availability", provenance: "archive", oldAvailability: null, newAvailability: "available" });
  const events = { generatedAt: point.observedAt, events: [event] };
  expect(await fetchGpuEvents(undefined, { getCloudGpuEvents: async () => events })).toEqual(events);
});

test("changing account or plan cannot reuse cached full data", async () => {
  gpuBoardCache.reset();
  const user = spyOn(apiClient, "getCurrentUser");
  const full = { id: "full-user", emailVerified: true, plan: "pro" } as NonNullable<ReturnType<typeof apiClient.getCurrentUser>>;
  user.mockReturnValue(full);
  try {
    await gpuBoardCache.load(`${gpuCacheScope()}:board`, async () => gpuBoard());
    expect(getCachedGpuBoard()).not.toBeNull();
    user.mockReturnValue({ ...full, plan: "free" });
    expect(getCachedGpuBoard()).toBeNull();
    user.mockReturnValue({ ...full, id: "other-user" });
    expect(getCachedGpuBoard()).toBeNull();
    user.mockReturnValue(null);
    expect(getCachedGpuBoard()).toBeNull();
  } finally { user.mockRestore(); gpuBoardCache.reset(); }
});
