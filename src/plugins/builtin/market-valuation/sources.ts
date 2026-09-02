import type { FredSeriesData } from "../../../data/fred-series";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import type { ChartResponse } from "../../../sources/yahoo-finance/types";
import { httpFetch } from "../../../utils/http-transport";
import type { SeriesDef } from "./defs";
import type { DatedObservation, DatedSeries } from "./series";

const yahoo = new YahooHttpClient();

/**
 * FRED drops requests that claim to be a browser without sending a browser's
 * other headers, so identify honestly. A `Name/Version` shaped agent is served;
 * a spoofed `Mozilla/5.0 ...` string hangs until the request times out.
 */
const FRED_CSV_HEADERS = {
  Accept: "text/csv,text/plain,*/*",
  "User-Agent": "Gloomberb/1.0 (+https://gloom.sh)",
};

export function yahooSymbolFor(def: SeriesDef): string | undefined {
  switch (def.source.kind) {
    case "yahoo-index":
      return def.source.symbol;
    case "fred":
      return undefined;
    default: {
      const _exhaustive: never = def.source;
      return _exhaustive;
    }
  }
}

export function provenanceFor(def: SeriesDef): DatedSeries["provenance"] {
  switch (def.source.kind) {
    case "yahoo-index":
      return "yahoo";
    case "fred":
      return "fred";
    default: {
      const _exhaustive: never = def.source;
      return _exhaustive;
    }
  }
}

export function isUnsupportedFredSeries(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported fred series/i.test(message);
}

export function fredDataToDatedSeries(
  data: FredSeriesData,
  seriesId: string,
  provenance: DatedSeries["provenance"],
): DatedSeries {
  return { seriesId, observations: data.observations, provenance };
}

export function datedSeriesToCachePayload(series: DatedSeries): FredSeriesData {
  return { observations: series.observations, info: null };
}

export function parseFredGraphCsv(csv: string, seriesId: string): DatedSeries {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2 || !lines[0]!.includes("observation_date")) {
    throw new Error(`Unexpected FRED CSV for ${seriesId}`);
  }

  const observations: DatedObservation[] = [];
  for (const line of lines.slice(1)) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const raw = line.slice(comma + 1).trim();
    if (raw === "" || raw === ".") {
      observations.push({ date, value: null });
      continue;
    }
    const value = Number(raw);
    observations.push({ date, value: Number.isFinite(value) ? value : null });
  }

  if (!observations.some((obs) => obs.value != null)) {
    throw new Error(`FRED CSV has no observations for ${seriesId}`);
  }

  return { seriesId, observations, provenance: "fred-csv" };
}

export async function loadFredGraphCsvSeries(seriesId: string): Promise<DatedSeries> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const response = await httpFetch(url, {
    headers: FRED_CSV_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`FRED CSV HTTP ${response.status} for ${seriesId}`);
  }
  return parseFredGraphCsv(body, seriesId);
}

function utcDate(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

export function yahooChartToDatedSeries(payload: ChartResponse, seriesId: string): DatedSeries {
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!timestamps?.length || !closes) {
    throw new Error(payload.chart?.error?.description || `No chart data for ${seriesId}`);
  }

  const observations: DatedObservation[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    observations.push({ date: utcDate(timestamps[i]!), value: close });
  }
  if (observations.length === 0) {
    throw new Error(`No chart data for ${seriesId}`);
  }

  return { seriesId, observations, provenance: "yahoo" };
}

function yahooDailyHistoryFromEpochQuery(nowSec: number): URLSearchParams {
  return new URLSearchParams({
    period1: "0",
    period2: String(nowSec),
    interval: "1d",
    events: "div,split",
  });
}

export async function loadYahooDailyIndexFromEpoch(symbol: string, seriesId: string): Promise<DatedSeries> {
  const params = yahooDailyHistoryFromEpochQuery(Math.floor(Date.now() / 1000));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  const payload = await yahoo.fetchJson<ChartResponse>(url);
  return yahooChartToDatedSeries(payload, seriesId);
}
