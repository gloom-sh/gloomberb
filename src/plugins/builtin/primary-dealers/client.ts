import { httpFetch } from "../../../utils/http-transport";
import { isoDateOrNull, numericOrNull, recordOrNull, textOrNull } from "../../../utils/guards";
import {
  boardAsOf,
  selectSeries,
  toDealerRow,
  type CatalogEntry,
  type DealerRow,
  type DealerTab,
} from "./model";

const LIST_URL = "https://markets.newyorkfed.org/api/pd/list/timeseries.json";
const FETCH_TIMEOUT_MS = 15_000;

interface SeriesPoint {
  asOf: string;
  value: number;
}

interface ParsedSeries {
  keyid: string;
  latest: SeriesPoint | null;
  previous: SeriesPoint | null;
}

export interface DealerBoard {
  seriesBreak: string;
  positions: DealerRow[];
  fails: DealerRow[];
  asOf: string | null;
}

function parseCatalog(payload: unknown): CatalogEntry[] {
  const root = recordOrNull(payload);
  const pd = recordOrNull(root?.pd);
  const rows = Array.isArray(pd?.timeseries) ? pd.timeseries : Array.isArray(root?.timeseries) ? root.timeseries : [];
  const entries: CatalogEntry[] = [];
  for (const raw of rows) {
    const row = recordOrNull(raw);
    if (!row) continue;
    const seriesBreak = textOrNull(row.seriesbreak) ?? textOrNull(row.seriesBreak);
    const keyid = textOrNull(row.keyid) ?? textOrNull(row.keyId);
    if (!seriesBreak || !keyid) continue;
    entries.push({ seriesBreak, keyid, description: textOrNull(row.description) ?? "" });
  }
  return entries;
}

/** Latest two observations. Points may arrive oldest-last or newest-last. */
function parseSeriesObservations(payload: unknown, fallbackKeyid = ""): ParsedSeries {
  const root = recordOrNull(payload);
  const pd = recordOrNull(root?.pd);
  const rows = Array.isArray(pd?.timeseries) ? pd.timeseries : Array.isArray(root?.timeseries) ? root.timeseries : [];
  const points: Array<SeriesPoint & { keyid: string }> = [];
  for (const raw of rows) {
    const row = recordOrNull(raw);
    if (!row) continue;
    const asOf = isoDateOrNull(row.asofdate) ?? isoDateOrNull(row.asOfDate) ?? isoDateOrNull(row.date);
    const value = numericOrNull(row.value);
    if (!asOf || value == null) continue;
    points.push({
      asOf,
      value,
      keyid: textOrNull(row.keyid) ?? fallbackKeyid,
    });
  }
  points.sort((a, b) => a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0);
  const latest = points.length > 0 ? points[points.length - 1] ?? null : null;
  const previous = points.length >= 2 ? points[points.length - 2] ?? null : null;
  return {
    keyid: latest?.keyid || fallbackKeyid,
    latest: latest ? { asOf: latest.asOf, value: latest.value } : null,
    previous: previous ? { asOf: previous.asOf, value: previous.value } : null,
  };
}

function seriesUrl(seriesBreak: string, keyid: string): string {
  return `https://markets.newyorkfed.org/api/pd/get/${encodeURIComponent(seriesBreak)}/timeseries/${encodeURIComponent(keyid)}.json`;
}

async function readJson(url: string): Promise<unknown> {
  const response = await httpFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "gloomberb" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

export async function fetchPrimaryDealers(): Promise<DealerBoard> {
  const selected = selectSeries(parseCatalog(await readJson(LIST_URL)));
  const jobs: Array<{ entry: CatalogEntry; tab: DealerTab }> = [
    ...selected.positions.map((entry) => ({ entry, tab: "positions" as const })),
    ...selected.fails.map((entry) => ({ entry, tab: "fails" as const })),
  ];
  if (jobs.length === 0) throw new Error("No position series were listed.");
  const rows = (await Promise.all(jobs.map(async ({ entry, tab }) => {
    const parsed = parseSeriesObservations(await readJson(seriesUrl(entry.seriesBreak, entry.keyid)), entry.keyid);
    return toDealerRow(entry, parsed, tab);
  }))).filter((row) => row.latest != null);
  if (rows.length === 0) throw new Error("No positions were recognized.");
  return {
    seriesBreak: selected.seriesBreak,
    positions: rows.filter((row) => row.tab === "positions"),
    fails: rows.filter((row) => row.tab === "fails"),
    asOf: boardAsOf(rows),
  };
}
