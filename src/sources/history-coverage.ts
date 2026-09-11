import type { PriceHistorySource, PricePoint, TickerFinancials } from "../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import { getPricePointTimestamp } from "../utils/price-history";
import { ProviderMissError } from "./provider-errors";

export const SHELL_VERIFIED_LINEAGE_START = "2005-07-21";
const coverageMessage = (providers: PriceHistorySource["provider"][]) => `${providers.map((provider) => provider === "yahoo" ? "Yahoo" : "Twelve Data").join(" and ")} London Shell coverage begins 2005-07-21; earlier share lineage is unverified.`;

export class HistoryCoverageError extends ProviderMissError {
  constructor(provider: PriceHistorySource["provider"] = "yahoo") { super(coverageMessage([provider])); this.name = "HistoryCoverageError"; }
}

export function hasShellCoverageRestriction(value: unknown): value is { source: PriceHistorySource["provider"]; reasonCode: "UNVERIFIED_PREDECESSOR_LINEAGE"; verifiedLineageStart: "2005-07-21" } {
  const coverage = value as { source?: unknown; reasonCode?: unknown; verifiedLineageStart?: unknown } | null;
  return (coverage?.source === "yahoo" || coverage?.source === "twelvedata") && coverage.reasonCode === "UNVERIFIED_PREDECESSOR_LINEAGE"
    && coverage.verifiedLineageStart === SHELL_VERIFIED_LINEAGE_START;
}

export function isShellLondonTarget(symbol: string, exchange?: string): boolean {
  const parsed = parsePublicTickerKey(symbol);
  const venue = canonicalExchange(parsed.exchange || exchange);
  return (parsed.symbol === "SHEL" && venue === "LSE")
    || (parsed.symbol === "SHEL.L" && (!venue || venue === "LSE"));
}

export function verifiedPriceHistorySource(value: unknown): PriceHistorySource | undefined {
  const source = value as Partial<PriceHistorySource> | null;
  if (!source || source.symbol !== "SHEL" || source.exchange !== "LSE" || source.currency !== "GBP"
    || !["yahoo", "twelvedata"].includes(source.provider ?? "")
    || source.verifiedLineageStart !== SHELL_VERIFIED_LINEAGE_START) return undefined;
  return { provider: source.provider!, symbol: "SHEL", exchange: "LSE", currency: "GBP",
    ...(source.verifiedLineageStart ? { verifiedLineageStart: source.verifiedLineageStart } : {}) };
}

/** Old cloud arrays lack upstream provenance. Retire only affected London
 * source records; ordinary modern histories and independent providers survive.
 * Both exact Yahoo and Twelve London histories share the unreconciled basis. */
export function hasUnverifiedShellHistory(
  points: readonly PricePoint[], target: { symbol: string; exchange?: string }, sourceKey: string,
  requestedStart?: number,
): boolean {
  if (!isShellLondonTarget(target.symbol, target.exchange)
    || !["provider:yahoo", "provider:gloomberb-cloud"].includes(sourceKey)) return false;
  const cutoff = Date.parse(SHELL_VERIFIED_LINEAGE_START);
  return points.some((point) => getPricePointTimestamp(point) < cutoff)
    // Older clients dropped even corrected source provenance. Refetch those
    // cached long windows to recover the explanation, without invalidating 1Y.
    || (requestedStart !== undefined && requestedStart < cutoff && points.length > 0
      && !points.some((point) => verifiedPriceHistorySource(point.historySource)));
}

export function historyCoverageNotice(points: readonly PricePoint[], requestedStart: number | null): string | null {
  if (requestedStart !== null && requestedStart >= Date.parse(SHELL_VERIFIED_LINEAGE_START)) return null;
  const providers = [...new Set(points.flatMap((point) => {
    const source = verifiedPriceHistorySource(point.historySource);
    return source ? [source.provider] : [];
  }))];
  return providers.length ? coverageMessage(providers) : null;
}

export function sanitizeShellFinancialHistory(
  value: TickerFinancials, target: { symbol: string; exchange?: string }, sourceKey: string,
): TickerFinancials {
  return hasUnverifiedShellHistory(value.priceHistory, target, sourceKey)
    ? { ...value, priceHistory: [] } : value;
}

/** The issuer's London A-share dataset starts here. Yahoo's preceding current-
 * ticker history contains an unreconciled 1997 discontinuity. Corroborated
 * post-unification samples establish A-share lineage, not every daily price.
 * Do not reconstruct predecessor prices using an assumed split or FX ratio. */
export function applyYahooHistoryCoverage(
  symbol: string,
  metadata: { symbol?: unknown; exchangeName?: unknown; currency?: unknown },
  interval: string,
  points: PricePoint[],
): PricePoint[] {
  if (symbol.toUpperCase() !== "SHEL.L" || /^\d+(m|h)$/i.test(interval)) return points;
  if (metadata.symbol !== "SHEL.L" || typeof metadata.exchangeName !== "string"
    || canonicalExchange(metadata.exchangeName) !== "LSE" || !["GBp", "GBP"].includes(String(metadata.currency))) {
    throw new Error("Shell London history source identity could not be verified");
  }
  const historySource: PriceHistorySource = {
    provider: "yahoo", symbol: "SHEL", exchange: "LSE", currency: "GBP",
    verifiedLineageStart: SHELL_VERIFIED_LINEAGE_START,
  };
  // Yahoo timestamps identify the start of a bar. Drop a whole spanning weekly
  // or monthly bar; retaining its close would leave unreconciled OHLC values.
  const cutoff = Date.parse(SHELL_VERIFIED_LINEAGE_START);
  const retained = points.filter((point) => point.date.getTime() >= cutoff)
    .map((point) => ({ ...point, historySource }));
  if (points.length > 0 && retained.length === 0) throw new HistoryCoverageError();
  return retained;
}
