import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import { httpFetch } from "../../../utils/http-transport";
import type { IPORecord, IPOStatus } from "./types";

export const STOCKANALYSIS_IPO_CONNECTION_ID = "stockanalysis-ipo";

const SA_RECENT_URL = "https://stockanalysis.com/ipos/__data.json";
const SA_CALENDAR_URL = "https://stockanalysis.com/ipos/calendar/__data.json";
const FETCH_TIMEOUT_MS = 15_000;

const SA_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let connectionHealth: ConnectionHealthRegistry | null = null;

export function attachIpoCalendarHealth(health?: ConnectionHealthRegistry): void {
  connectionHealth = health ?? null;
}

export function resetIpoCalendarHealth(): void {
  connectionHealth = null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function str(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value;
}

/**
 * Resolve a SvelteKit devalue reference from the flat data array.
 * Objects and arrays store integer indices into the same flat array;
 * primitives are returned directly.
 */
function resolveRef(flat: unknown[], index: number, depth = 0): unknown {
  if (depth > 20) return undefined;
  if (typeof index !== "number" || index < 0 || index >= flat.length) return undefined;
  const value = flat[index];
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "number" ? resolveRef(flat, item, depth + 1) : item,
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = typeof val === "number" ? resolveRef(flat, val, depth + 1) : val;
  }
  return result;
}

function isIpoRecordShape(value: unknown): value is Record<string, unknown> {
  return isObject(value) && "s" in value && "ipoDate" in value;
}

function countIpoRecords(flat: unknown[]): number {
  let count = 0;
  for (const item of flat) {
    if (isIpoRecordShape(item)) count += 1;
  }
  return count;
}

/**
 * SvelteKit `__data.json` ships several nodes. Node 0 is session/cookie
 * boilerplate whose first entry is an object; the IPO rows live in a later
 * node. Select by record shape, not by the first object-shaped node.
 */
export function getFlatData(payload: unknown): unknown[] | null {
  const root = isObject(payload) ? payload : null;
  const nodes = root?.nodes;
  if (!isRecordArray(nodes)) return null;

  let best: unknown[] | null = null;
  let bestCount = 0;
  for (const node of nodes) {
    const nodeData = isObject(node) ? node.data : undefined;
    if (!isRecordArray(nodeData) || nodeData.length === 0) continue;
    const count = countIpoRecords(nodeData);
    if (count > bestCount) {
      best = nodeData;
      bestCount = count;
    }
  }
  return best;
}

function findRecordObjects(flat: unknown[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const item of flat) {
    if (isIpoRecordShape(item)) records.push(item);
  }
  return records;
}

function resolveRecord(flat: unknown[], record: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    resolved[key] = typeof val === "number" ? resolveRef(flat, val) : val;
  }
  return resolved;
}

function parseDate(value: unknown): Date | null {
  const text = str(value);
  if (!text) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parsePriceRange(value: unknown): [number, number] | null {
  const text = str(value);
  if (!text) return null;
  const match = text.match(/\$?([\d.]+)\s*-\s*\$?([\d.]+)/);
  if (!match) return null;
  const low = parseFloat(match[1]!);
  const high = parseFloat(match[2]!);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return [low, high];
}

function recordFromRecent(flat: unknown[], record: Record<string, unknown>): IPORecord | null {
  const resolved = resolveRecord(flat, record);
  const ticker = str(resolved.s);
  const companyName = str(resolved.n);
  const date = parseDate(resolved.ipoDate);
  if (!ticker || !companyName || !date) return null;

  const pricedPrice = num(resolved.ipoPrice);
  const closePrice = num(resolved.ippc);
  const change1D = num(resolved.ipr);
  const hasPerformance = closePrice != null || change1D != null;
  const status: IPOStatus = hasPerformance ? "trading" : "priced";

  return {
    ticker,
    companyName,
    date,
    status,
    exchange: null,
    offerSize: null,
    priceRange: null,
    pricedPrice,
    shares: null,
    closePrice,
    change1D,
  };
}

function recordFromCalendar(flat: unknown[], record: Record<string, unknown>): IPORecord | null {
  const resolved = resolveRecord(flat, record);
  const ticker = str(resolved.s);
  const companyName = str(resolved.n);
  const date = parseDate(resolved.ipoDate);
  if (!ticker || !companyName || !date) return null;

  const exchange = str(resolved.exchange);
  const priceRange = parsePriceRange(resolved.ipoPriceRange);
  const shares = num(resolved.sharesOffered);
  const dealSize = num(resolved.ds);
  const offerSize = dealSize ?? (shares != null && priceRange != null ? shares * priceRange[0] : null);

  return {
    ticker,
    companyName,
    date,
    status: "upcoming",
    exchange,
    offerSize,
    priceRange,
    pricedPrice: null,
    shares,
    closePrice: null,
    change1D: null,
  };
}

function getCalendarSectionIndices(flat: unknown[], root: Record<string, unknown>, field: string): number[] {
  const index = num(root[field]);
  if (index == null) return [];
  const value = flat[index];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number");
}

function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  return httpFetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }
    return response.json();
  });
}

function fetchStockAnalysis(url: string, operation: string): Promise<unknown> {
  const request = () => fetchJson(url, {
    "User-Agent": SA_USER_AGENT,
    Accept: "application/json",
  });
  return connectionHealth?.hasSource(STOCKANALYSIS_IPO_CONNECTION_ID)
    ? connectionHealth.track(STOCKANALYSIS_IPO_CONNECTION_ID, operation, request)
    : request();
}

async function fetchRecentIpos(): Promise<IPORecord[]> {
  const payload = await fetchStockAnalysis(SA_RECENT_URL, "fetchRecent");
  const flat = getFlatData(payload);
  if (!flat) return [];
  const records = findRecordObjects(flat);
  return records
    .map((record) => recordFromRecent(flat, record))
    .filter((record): record is IPORecord => record !== null);
}

function parseCalendarRecords(flat: unknown[]): IPORecord[] {
  const root = isObject(flat[0]) ? flat[0] : null;
  if (root) {
    const sections = ["thisWeekData", "nextWeekData", "laterData"];
    const results: IPORecord[] = [];
    for (const field of sections) {
      const indices = getCalendarSectionIndices(flat, root, field);
      for (const idx of indices) {
        const record = isObject(flat[idx]) ? flat[idx] as Record<string, unknown> : null;
        if (!record) continue;
        const parsed = recordFromCalendar(flat, record);
        if (parsed) results.push(parsed);
      }
    }
    if (results.length > 0) return results;
  }

  return findRecordObjects(flat)
    .map((record) => recordFromCalendar(flat, record))
    .filter((record): record is IPORecord => record !== null);
}

async function fetchUpcomingIpos(): Promise<IPORecord[]> {
  const payload = await fetchStockAnalysis(SA_CALENDAR_URL, "fetchUpcoming");
  const flat = getFlatData(payload);
  if (!flat) return [];
  return parseCalendarRecords(flat);
}

function dedupeAndSort(records: IPORecord[]): IPORecord[] {
  const byTicker = new Map<string, IPORecord>();
  const statusOrder: Record<IPOStatus, number> = { upcoming: 0, priced: 1, trading: 2 };
  for (const record of records) {
    const key = record.ticker.toUpperCase();
    const existing = byTicker.get(key);
    if (!existing || statusOrder[record.status] < statusOrder[existing.status]) {
      byTicker.set(key, record);
    }
  }
  return [...byTicker.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

export interface IpoCalendarFetchResult {
  records: IPORecord[];
  /** One entry per endpoint that failed, so a half board is never shown as whole. */
  errors: string[];
}

export async function fetchIpoCalendar(): Promise<IpoCalendarFetchResult> {
  const [recentResult, upcomingResult] = await Promise.allSettled([
    fetchRecentIpos(),
    fetchUpcomingIpos(),
  ]);

  const records: IPORecord[] = [];
  const errors: string[] = [];
  if (recentResult.status === "fulfilled") records.push(...recentResult.value);
  else errors.push(`recent: ${recentResult.reason}`);
  if (upcomingResult.status === "fulfilled") records.push(...upcomingResult.value);
  else errors.push(`upcoming: ${upcomingResult.reason}`);

  if (records.length === 0 && errors.length > 0) {
    throw new Error(`IPO data unavailable (${errors.join("; ")})`);
  }

  return { records: dedupeAndSort(records), errors };
}
