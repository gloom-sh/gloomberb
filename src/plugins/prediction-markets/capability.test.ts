import { afterEach, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../utils/http-transport";
import {
  predictionChartSeriesCapability,
  predictionHistoryPoints,
  predictionSeriesId,
} from "./capability";
import {
  attachPredictionMarketsPersistence,
  resetPredictionMarketsPersistence,
} from "./services/fetch";
import { MemoryPersistence } from "./test-helpers";
import type { PredictionMarketSummary } from "./types";

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200 });
}

function identity(overrides: Partial<PredictionMarketSummary>): PredictionMarketSummary {
  return {
    venue: "polymarket",
    marketId: "market-1",
    eventId: "event-1",
    ...overrides,
  } as PredictionMarketSummary;
}

afterEach(() => {
  setHttpFetchTransport(null);
  resetPredictionMarketsPersistence();
});

test("prediction chart history restores persisted dates, drops invalid rows, and sorts observations", () => {
  const points = predictionHistoryPoints([
    { date: "2026-02-02T00:00:00Z" as unknown as Date, close: 0.6 },
    { date: new Date("invalid"), close: 0.9 },
    { date: "2026-02-01T00:00:00Z" as unknown as Date, close: 0.4, open: 0.3 },
  ], "polymarket");

  expect(points.map((point) => [point.date.toISOString(), point.value])).toEqual([
    ["2026-02-01T00:00:00.000Z", 0.4],
    ["2026-02-02T00:00:00.000Z", 0.6],
  ]);
  expect(points[0]).toMatchObject({ open: 0.3, provenance: { providerId: "polymarket", quality: "reported" } });
});

test("stable prediction IDs retain provider lookup identity", () => {
  expect(predictionSeriesId(identity({ venue: "kalshi", eventTicker: "EVT-1", marketId: "MKT-1" })))
    .toBe("kalshi/EVT-1/MKT-1");
  expect(predictionSeriesId(identity({ venue: "polymarket", eventId: "123", marketId: "456" })))
    .toBe("polymarket/123/456");
  expect(predictionSeriesId(identity({ venue: "polymarket", eventId: undefined }))).toBeNull();
});

test("catalog limit bounds provider search hydration", async () => {
  const requested: string[] = [];
  setHttpFetchTransport(async (url) => {
    requested.push(url);
    if (url.includes("public-search")) {
      return json({ events: Array.from({ length: 5 }, (_, index) => ({ id: `event-${index + 1}` })) });
    }
    if (url.includes("gamma-api.polymarket.com/events/event-")) {
      const eventId = url.split("/").at(-1)!;
      return json({
        id: eventId,
        title: `Rates ${eventId}`,
        markets: [{
          id: `market-${eventId}`,
          question: `Rates ${eventId}`,
          active: true,
          closed: false,
          outcomes: ["Yes", "No"],
          outcomePrices: ["0.5", "0.5"],
          clobTokenIds: [`yes-${eventId}`, `no-${eventId}`],
        }],
      });
    }
    if (url.includes("api.elections.kalshi.com/trade-api/v2/events")) {
      return json({ events: [] });
    }
    throw new Error(`Unexpected URL ${url}`);
  });

  const items = await predictionChartSeriesCapability.provider.search!({ query: "rates", limit: 2 });

  expect(items).toHaveLength(2);
  expect(requested.filter((url) => url.includes("gamma-api.polymarket.com/events/event-"))).toHaveLength(2);
  expect(requested.some((url) => url.includes("api.elections.kalshi.com") && url.includes("limit=20"))).toBe(true);
});

test("polymarket resolution reloads the event and follows a rotated YES token", async () => {
  const requested: string[] = [];
  setHttpFetchTransport(async (url) => {
    requested.push(url);
    if (url.endsWith("/events/event-1")) {
      return json({
        id: "event-1",
        title: "Current event",
        markets: [{
          id: "market-1",
          question: "Current market title",
          active: true,
          closed: false,
          outcomes: ["Yes", "No"],
          outcomePrices: ["0.7", "0.3"],
          clobTokenIds: ["rotated-yes", "rotated-no"],
        }],
      });
    }
    if (url.includes("prices-history")) return json({ history: [{ t: 1_700_000_000, p: 0.7 }] });
    throw new Error(`Unexpected URL ${url}`);
  });

  const resolved = await predictionChartSeriesCapability.provider.resolve({
    seriesId: "polymarket/event-1/market-1",
    viewport: { range: "1M", resolution: "auto" },
  });

  expect(resolved.label).toBe("Current market title");
  expect(resolved.points[0]?.value).toBe(0.7);
  expect(requested.some((url) => url.includes("market=rotated-yes"))).toBe(true);
});

test("polymarket pans request and cache their bounded history windows", async () => {
  attachPredictionMarketsPersistence(new MemoryPersistence());
  const historyRequests: string[] = [];
  setHttpFetchTransport(async (url) => {
    if (url.endsWith("/events/event-1")) {
      return json({
        id: "event-1",
        title: "Current event",
        markets: [{
          id: "market-1",
          question: "Current market title",
          active: true,
          closed: false,
          outcomes: ["Yes", "No"],
          outcomePrices: ["0.7", "0.3"],
          clobTokenIds: ["yes-token", "no-token"],
        }],
      });
    }
    if (url.includes("prices-history")) {
      historyRequests.push(url);
      const start = Number(new URL(url).searchParams.get("startTs"));
      return json({ history: [{ t: start + 1, p: 0.7 }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  const viewport = (start: string, end: string) => ({
    range: "1W" as const,
    resolution: "auto" as const,
    dateWindow: { start, end },
  });
  const january = viewport("2026-01-01T00:00:00.000Z", "2026-01-08T00:00:00.000Z");
  const february = viewport("2026-02-01T00:00:00.000Z", "2026-02-08T00:00:00.000Z");

  await predictionChartSeriesCapability.provider.resolve({
    seriesId: "polymarket/event-1/market-1",
    viewport: january,
  });
  const panned = await predictionChartSeriesCapability.provider.resolve({
    seriesId: "polymarket/event-1/market-1",
    viewport: february,
  });
  await predictionChartSeriesCapability.provider.resolve({
    seriesId: "polymarket/event-1/market-1",
    viewport: january,
  });

  expect(historyRequests).toHaveLength(2);
  expect(historyRequests.map((url) => {
    const params = new URL(url).searchParams;
    return [params.get("startTs"), params.get("endTs"), params.get("interval")];
  })).toEqual([
    [String(Date.parse(january.dateWindow.start) / 1000), String(Date.parse(january.dateWindow.end) / 1000), null],
    [String(Date.parse(february.dateWindow.start) / 1000), String(Date.parse(february.dateWindow.end) / 1000), null],
  ]);
  expect(panned.points[0]?.date.toISOString()).toBe("2026-02-01T00:00:01.000Z");
});

test("aborting catalog search stops Polymarket event hydration without caching it", async () => {
  attachPredictionMarketsPersistence(new MemoryPersistence());
  let searchRequests = 0;
  let eventRequests = 0;
  let markHydrationStarted: (() => void) | undefined;
  const hydrationStarted = new Promise<void>((resolve) => {
    markHydrationStarted = resolve;
  });
  setHttpFetchTransport(async (url, init) => {
    if (url.includes("public-search")) {
      searchRequests += 1;
      return json({ events: [{ id: "event-1" }] });
    }
    if (url.endsWith("/events/event-1")) {
      eventRequests += 1;
      if (eventRequests === 1) {
        markHydrationStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return json({
        id: "event-1",
        title: "Rates",
        markets: [{
          id: "market-1",
          question: "Rates",
          active: true,
          closed: false,
          outcomes: ["Yes", "No"],
          outcomePrices: ["0.5", "0.5"],
          clobTokenIds: ["yes", "no"],
        }],
      });
    }
    if (url.includes("api.elections.kalshi.com")) return json({ events: [] });
    throw new Error(`Unexpected URL ${url}`);
  });

  const controller = new AbortController();
  const pending = predictionChartSeriesCapability.provider.search!({
    query: "rates",
    limit: 1,
    signal: controller.signal,
  });
  await hydrationStarted;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });

  const retried = await predictionChartSeriesCapability.provider.search!({ query: "rates", limit: 1 });
  expect(retried).toHaveLength(1);
  expect(searchRequests).toBe(2);
  expect(eventRequests).toBe(2);
});

test("kalshi resolution reloads the event before requesting current market history", async () => {
  const requested: string[] = [];
  setHttpFetchTransport(async (url) => {
    requested.push(url);
    if (url.endsWith("/events/EVT-1")) {
      return json({
        event: { title: "Current event", event_ticker: "EVT-1", series_ticker: "SERIES-NEW" },
        markets: [{
          ticker: "MKT-1",
          event_ticker: "EVT-1",
          title: "Current Kalshi market",
          status: "active",
          market_type: "binary",
          last_price_dollars: "0.55",
        }],
      });
    }
    if (url.includes("/candlesticks")) {
      return json({ candlesticks: [{ end_period_ts: 1_700_000_000, price: { close_dollars: "0.55" } }] });
    }
    throw new Error(`Unexpected URL ${url}`);
  });

  const resolved = await predictionChartSeriesCapability.provider.resolve({
    seriesId: "kalshi/EVT-1/MKT-1",
    viewport: {
      range: "1W",
      resolution: "auto",
      dateWindow: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-08T00:00:00.000Z" },
    },
  });

  expect(resolved.label).toBe("Current Kalshi market");
  expect(requested.some((url) => url.includes("/series/SERIES-NEW/markets/MKT-1/candlesticks"))).toBe(true);
  expect(requested.some((url) => url.includes("start_ts=1767225600") && url.includes("end_ts=1767830400"))).toBe(true);
});

test("resolution reports an actionable error when a persisted market disappears", async () => {
  setHttpFetchTransport(async () => json({ id: "event-1", title: "Current event", markets: [] }));

  await expect(predictionChartSeriesCapability.provider.resolve({
    seriesId: "polymarket/event-1/missing",
    viewport: { range: "1M", resolution: "auto" },
  })).rejects.toThrow("no longer resolvable. Remove or replace this chart series");
});
