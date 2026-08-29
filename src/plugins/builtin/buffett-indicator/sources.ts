import type { FredSeriesData } from "../../../data/fred-series";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import type { ChartResponse } from "../../../sources/yahoo-finance/types";
import { httpFetch } from "../../../utils/http-transport";
import { uniqueSeriesDefs } from "./model";

const yahoo = new YahooHttpClient();

const FRED_CSV_HEADERS = {
  Accept: "text/csv,text/plain,*/*",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

export function yahooSymbolFor(seriesId: string): string | undefined {
  return uniqueSeriesDefs().find((def) => def.seriesId === seriesId)?.yahooSymbol;
}

export function isUnsupportedFredSeries(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported fred series/i.test(message);
}

export function parseFredGraphCsv(csv: string, seriesId: string): FredSeriesData {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2 || !lines[0]!.includes("observation_date")) {
    throw new Error(`Unexpected FRED CSV for ${seriesId}`);
  }

  const observations: FredSeriesData["observations"] = [];
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

  return {
    observations,
    info: {
      id: seriesId,
      title: seriesId,
      units: "",
      frequency: "",
      seasonalAdjustment: "",
      source: "FRED",
      notes: "",
    },
  };
}

export async function loadFredGraphCsvSeries(seriesId: string): Promise<FredSeriesData> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const response = await httpFetch(url, {
    headers: FRED_CSV_HEADERS,
    signal: AbortSignal.timeout(8_000),
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

export function yahooChartToFredSeries(payload: ChartResponse, seriesId: string): FredSeriesData {
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!timestamps?.length || !closes) {
    throw new Error(payload.chart?.error?.description || `No chart data for ${seriesId}`);
  }

  const observations: FredSeriesData["observations"] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    observations.push({ date: utcDate(timestamps[i]!), value: close });
  }
  if (observations.length === 0) {
    throw new Error(`No chart data for ${seriesId}`);
  }

  return {
    observations,
    info: {
      id: seriesId,
      title: result.meta?.longName || result.meta?.shortName || seriesId,
      units: "Index",
      frequency: "Daily",
      seasonalAdjustment: "Not Seasonally Adjusted",
      source: "Yahoo Finance",
      notes: "",
    },
  };
}

export async function loadYahooIndexSeries(symbol: string, seriesId: string): Promise<FredSeriesData> {
  const period2 = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    period1: "0",
    period2: String(period2),
    interval: "1d",
    events: "div,split",
  });
  // Yahoo `range=max` on ^W5000 returns monthly bars. period1=0 keeps daily history.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  const payload = await yahoo.fetchJson<ChartResponse>(url);
  return yahooChartToFredSeries(payload, seriesId);
}
