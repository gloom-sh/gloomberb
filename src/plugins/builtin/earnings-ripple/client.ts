import type { EarningsCalendarPayload, EarningsCalendarQuery } from "../../../api-client/earnings";
import type { SupplyChainPayload } from "../../../api-client/supply-chain";
import { errorMessage } from "../../../utils/errors";
import { addDays, newYorkToday } from "../earnings/board-model";
import { loadEarningsBoard } from "../earnings/client";
import { loadSupplyChain } from "../supply-chain/client";
import { projectRipple, rippleCompanyTickers, RIPPLE_DAYS, type RippleRow } from "./model";

export interface RippleSources {
  supplyChain(symbol: string): Promise<SupplyChainPayload>;
  calendar(query: EarningsCalendarQuery): Promise<EarningsCalendarPayload>;
}

export interface RippleSnapshot {
  rows: RippleRow[];
  /** Holdings whose disclosures could not be read, with the reason. */
  failures: { symbol: string; error: string }[];
  /** Holdings whose disclosures the free preview cut short, so a missing link may only be hidden. */
  truncated: string[];
  stale: boolean;
  from: string;
  to: string;
}

/** The same caches SPLC and ERN fill, so opening either pane after this costs nothing. */
export function cachedRippleSources(accessKey: string, force = false): RippleSources & { staleFlags: boolean[] } {
  const staleFlags: boolean[] = [];
  return {
    staleFlags,
    supplyChain: async (symbol) => { const result = await loadSupplyChain(symbol, accessKey, force); staleFlags.push(result.stale); return result.payload; },
    calendar: async (query) => { const result = await loadEarningsBoard(query, force); staleFlags.push(result.stale); return result.payload; },
  };
}

const CONCURRENCY = 6;

export async function loadRipple(holdings: readonly string[], sources: RippleSources & { staleFlags?: boolean[] }, now = new Date()): Promise<RippleSnapshot> {
  const from = newYorkToday(now);
  const to = addDays(from, RIPPLE_DAYS);
  const chains = new Map<string, SupplyChainPayload>();
  const failures: RippleSnapshot["failures"] = [];
  const queue = [...new Set(holdings.map((symbol) => symbol.toUpperCase()))];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
      try { chains.set(symbol, await sources.supplyChain(symbol)); }
      catch (error) { failures.push({ symbol, error: errorMessage(error) }); }
    }
  }));
  const companies = rippleCompanyTickers(chains);
  const reports: EarningsCalendarPayload["reports"] = [];
  if (companies.length) {
    const symbols = [...new Set([...companies, ...holdings.map((symbol) => symbol.toUpperCase())])].sort();
    for (let offset = 0; offset < symbols.length; offset += 200) {
      const payload = await sources.calendar({ from, to, perDay: 0, symbols: symbols.slice(offset, offset + 200) });
      reports.push(...payload.reports);
    }
  }
  const truncated = [...chains].filter(([, chain]) => chain.truncated).map(([symbol]) => symbol).sort();
  return { rows: projectRipple(chains, reports), failures, truncated, stale: !!sources.staleFlags?.some(Boolean), from, to };
}
