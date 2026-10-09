import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { GeoLayerInfo, GeoRequest } from "../../../api-client/geo";
import { createGeoFixtureRequest } from "../../../test-support/test-fixture-geo";
import { GeoLayerFeed } from "./feed";
import { WORLD_GEO_VIEW, type GeoView } from "./layers";

function fakeTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
      now: () => now,
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.callback();
      }
      await flush();
    },
  };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function recordingRequest(): { request: GeoRequest; calls: Array<{ path: string; signal: AbortSignal }> } {
  const calls: Array<{ path: string; signal: AbortSignal }> = [];
  const fixture = createGeoFixtureRequest();
  return {
    calls,
    request: (path, init) => {
      calls.push({ path, signal: init!.signal! });
      return fixture(path, init);
    },
  };
}

function layer(overrides: Partial<GeoLayerInfo>): GeoLayerInfo {
  return {
    id: "chokepoints", name: "Chokepoints", group: "ships", geometry: "point", cadence: "daily", refreshSeconds: null,
    asOf: null, count: null, status: "ok", access: "free", columns: [], series: [], defaultVisible: true, ...overrides,
  };
}

const ZOOMED: GeoView = { bbox: [95, -5, 110, 10], zoom: 4 };
const PANNED: GeoView = { bbox: [96, -5, 111, 10], zoom: 4 };

describe("geo layer feed", () => {
  test("a new view aborts the request in flight and asks once after the view settles", async () => {
    const clock = fakeTimers();
    const { request, calls } = recordingRequest();
    const feed = new GeoLayerFeed(request, () => {}, { debounceMs: 250, timers: clock.timers });
    const vessels = layer({ id: "vessels", cadence: "live", refreshSeconds: 30 });

    feed.update([vessels], WORLD_GEO_VIEW, true);
    await flush();
    expect(calls).toHaveLength(1);
    expect(feed.snapshot()[0]!.clusters.length).toBeGreaterThan(0);

    feed.update([vessels], ZOOMED, true);
    feed.update([vessels], PANNED, true);
    expect(calls).toHaveLength(1);
    expect(feed.snapshot()[0]!.loading).toBe(true);
    await clock.advance(250);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.path).toContain("bbox=96,-5,111,10");
    expect(calls[1]!.path).toContain("zoom=4");
    const zoomed = feed.snapshot()[0]!;
    expect(zoomed.features.length).toBeGreaterThan(0);
    expect(zoomed.clusters).toEqual([]);

    feed.dispose();

    // A view change while a request is out aborts it.
    const signals: AbortSignal[] = [];
    const hanging = new GeoLayerFeed(((_path: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise(() => {});
    }) as GeoRequest, () => {}, { debounceMs: 250, timers: clock.timers });
    hanging.update([vessels], ZOOMED, true);
    hanging.update([vessels], PANNED, true);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    hanging.dispose();
  });

  test("live layers refresh on their own cadence, quietly, and stop while hidden", async () => {
    const clock = fakeTimers();
    const { request, calls } = recordingRequest();
    const feed = new GeoLayerFeed(request, () => {}, { timers: clock.timers });
    const vessels = layer({ id: "vessels", cadence: "live", refreshSeconds: 30 });
    const ports = layer({ id: "ports", cadence: "daily", refreshSeconds: null });

    feed.update([vessels, ports], WORLD_GEO_VIEW, true);
    await flush();
    expect(calls.map((call) => call.path.split("?")[0])).toEqual(["layers/vessels/features", "layers/ports/features"]);
    await clock.advance(30_000);
    expect(calls.filter((call) => call.path.startsWith("layers/vessels"))).toHaveLength(2);
    expect(calls.filter((call) => call.path.startsWith("layers/ports"))).toHaveLength(1);
    expect(feed.snapshot()[0]!.loading).toBe(false);

    feed.update([vessels, ports], WORLD_GEO_VIEW, false);
    await clock.advance(120_000);
    expect(calls.filter((call) => call.path.startsWith("layers/vessels"))).toHaveLength(2);
    // Back in view after its cadence: one catch-up request.
    feed.update([vessels, ports], WORLD_GEO_VIEW, true);
    await flush();
    expect(calls.filter((call) => call.path.startsWith("layers/vessels"))).toHaveLength(3);
    feed.dispose();
  });

  test("asks nothing below a layer's minimum zoom or for an unavailable layer, and caps what it draws", async () => {
    const clock = fakeTimers();
    const { request, calls } = recordingRequest();
    const feed = new GeoLayerFeed(request, () => {}, { timers: clock.timers });
    const vessels = layer({ id: "vessels", cadence: "live", refreshSeconds: 30, minZoom: 3 });
    const flights = layer({ id: "flights", status: "unavailable", statusNote: "Not connected yet" });

    feed.update([vessels, flights], WORLD_GEO_VIEW, true);
    await flush();
    expect(calls).toEqual([]);
    expect(feed.snapshot().map((state) => state.phase)).toEqual(["zoom", "unavailable"]);

    feed.update([vessels, flights], ZOOMED, true);
    await clock.advance(250);
    expect(calls.map((call) => call.path.split("?")[0])).toEqual(["layers/vessels/features"]);

    const flood: GeoRequest = async <T,>() => ({
      layer: "ports",
      asOf: null,
      total: 9000,
      truncated: false,
      features: Array.from({ length: 9000 }, (_, index) => ({
        id: `p${index}`, layer: "ports", entityKind: "port", label: `P${index}`, ts: null, props: {},
        geometry: { type: "Point", coordinates: [0, 0] },
      })),
    }) as T;
    const capped = new GeoLayerFeed(flood, () => {}, { timers: clock.timers });
    capped.update([layer({ id: "ports" })], WORLD_GEO_VIEW, true);
    await flush();
    expect(capped.snapshot()[0]!.features).toHaveLength(2000);
    expect(capped.snapshot()[0]!.truncated).toBe(true);
    feed.dispose();
    capped.dispose();
  });

  test("a rate-limited layer waits as long as the server asks, and a Pro layer locks quietly", async () => {
    const clock = fakeTimers();
    let calls = 0;
    const limited = new GeoLayerFeed((async () => {
      calls += 1;
      throw new ApiRequestError("Too many map requests", 429, 45_000, "geo_rate_limited");
    }) as GeoRequest, () => {}, { timers: clock.timers });
    const vessels = layer({ id: "vessels", cadence: "live", refreshSeconds: 15 });
    limited.update([vessels], WORLD_GEO_VIEW, true);
    await flush();
    expect(limited.snapshot()[0]!.phase).toBe("error");
    await clock.advance(30_000);
    // A new view does not jump the queue either.
    limited.update([vessels], ZOOMED, true);
    await clock.advance(5_000);
    expect(calls).toBe(1);
    await clock.advance(10_000);
    expect(calls).toBe(2);
    limited.dispose();

    const locked = new GeoLayerFeed((async () => {
      throw new ApiRequestError("This map layer needs Gloom Pro", 403, undefined, "pro_required");
    }) as GeoRequest, () => {}, { timers: clock.timers });
    locked.update([layer({ id: "ports" })], WORLD_GEO_VIEW, true);
    await flush();
    expect(locked.snapshot()[0]).toMatchObject({ phase: "locked", error: null });
    locked.dispose();
  });
});
