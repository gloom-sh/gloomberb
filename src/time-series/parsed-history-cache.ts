import type { PricePoint, QuoteMetadata } from "../types/financials";
import type { PriceHistoryResult } from "../types/price-history";
import type { InstrumentRef } from "../market-data/request-types";
import { instrumentIdentityKey } from "../utils/instrument-identity";
import type { TimeRange } from "./range";
import type { ChartResolutionSupport, ManualChartResolution } from "./resolution";

const MAX_PARSED_HISTORY = 32;
const parsedHistory = new Map<string, PriceHistoryResult>();

function listingKey(instrument: InstrumentRef): string {
  return instrumentIdentityKey({ ...instrument,
    brokerId: instrument.brokerId ?? instrument.instrument?.brokerId,
    brokerInstanceId: instrument.brokerInstanceId ?? instrument.instrument?.brokerInstanceId,
  });
}

export function parsedPriceHistoryKey(
  instrument: InstrumentRef,
  range: TimeRange,
  resolution?: ManualChartResolution,
): string {
  // This is an in-memory seed cache. Never reuse earlier symbol-only keys:
  // their observations may have come from a different broker contract.
  return JSON.stringify(["parsed-history-v2", listingKey(instrument), range, resolution ?? ""]);
}

/**
 * What a settled chart learned about a listing that its cached bars do not
 * carry: the quote's currency and instrument type, and the intervals its
 * source serves. A seed drawn without them labels its axes without units and
 * offers placeholder intervals, so the settled chart that replaces it a
 * moment later moves the plot and redraws every label.
 */
interface SeedListingFacts {
  quoteMetadata?: QuoteMetadata;
  resolutionSupport?: ChartResolutionSupport[];
}

const MAX_LISTING_FACTS = 64;
const listingFacts = new Map<string, SeedListingFacts>();

export function rememberSeedListingFacts(instrument: InstrumentRef, facts: SeedListingFacts): void {
  const key = listingKey(instrument);
  const merged = { ...listingFacts.get(key), ...facts };
  listingFacts.delete(key);
  listingFacts.set(key, merged);
  while (listingFacts.size > MAX_LISTING_FACTS) {
    const oldest = listingFacts.keys().next().value;
    if (oldest === undefined) break;
    listingFacts.delete(oldest);
  }
}

export function readSeedListingFacts(instrument: InstrumentRef): SeedListingFacts | undefined {
  return listingFacts.get(listingKey(instrument));
}

export function rememberParsedPriceHistory(
  key: string, points: PricePoint[], metadata?: Omit<PriceHistoryResult, "points">,
): void {
  if (points.length === 0) return;
  if (parsedHistory.has(key)) parsedHistory.delete(key);
  parsedHistory.set(key, { points, resolution: metadata?.resolution ?? null,
    ...(metadata?.session ? { session: { ...metadata.session } } : {}),
    ...(metadata?.sourceKey ? { sourceKey: metadata.sourceKey } : {}),
  });
  while (parsedHistory.size > MAX_PARSED_HISTORY) {
    const oldest = parsedHistory.keys().next().value;
    if (oldest === undefined) break;
    parsedHistory.delete(oldest);
  }
}

export function readParsedHistoryResult(key: string): PriceHistoryResult | undefined {
  return parsedHistory.get(key);
}
