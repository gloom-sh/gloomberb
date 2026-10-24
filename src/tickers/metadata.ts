import type { TickerMetadata, TickerPosition } from "../types/ticker";

const DEFAULT_TICKER_METADATA: Omit<TickerMetadata, "ticker" | "exchange" | "currency" | "name"> = {
  portfolios: [],
  watchlists: [],
  positions: [],
  broker_contracts: [],
  custom: {},
  tags: [],
};

/** A lot's cost FX rate, kept only whole: a positive rate and the currency it converts into. */
function hydrateCostFx(raw: Record<string, unknown>): Pick<TickerPosition, "costFxRate" | "costFxCurrency"> {
  const rate = raw.costFxRate ?? raw.cost_fx_rate;
  const currency = raw.costFxCurrency ?? raw.cost_fx_currency;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 && typeof currency === "string" && currency.trim()
    ? { costFxRate: rate, costFxCurrency: currency.trim() }
    : {};
}

function hydratePosition(raw: Record<string, unknown>): TickerPosition {
  const avgCost = Object.hasOwn(raw, "avgCost") ? raw.avgCost : raw.avg_cost;
  return {
    portfolio: (raw.portfolio as string) ?? "",
    shares: (raw.shares as number) ?? 0,
    avgCost: typeof avgCost === "number" && Number.isFinite(avgCost) ? avgCost : undefined,
    priceBasis: raw.priceBasis === "per-unit" || raw.priceBasis === "percent-of-par" ? raw.priceBasis : undefined,
    currency: (raw.currency as string) ?? undefined,
    dateAcquired: (raw.dateAcquired ?? raw.date_acquired) as string | undefined,
    ...hydrateCostFx(raw),
    broker: (raw.broker as string) ?? "manual",
    side: (raw.side as "long" | "short") ?? undefined,
    marketValue: (raw.marketValue ?? raw.market_value) as number | undefined,
    unrealizedPnl: (raw.unrealizedPnl ?? raw.unrealized_pnl) as number | undefined,
    multiplier: (raw.multiplier as number) ?? undefined,
    markPrice: (raw.markPrice ?? raw.mark_price) as number | undefined,
    brokerInstanceId: (raw.brokerInstanceId ?? raw.broker_instance_id) as string | undefined,
    brokerAccountId: (raw.brokerAccountId ?? raw.broker_account_id) as string | undefined,
    brokerContractId: (raw.brokerContractId ?? raw.broker_contract_id) as number | undefined,
    brokerContractIdentity: typeof raw.brokerContractIdentity === "string" ? raw.brokerContractIdentity : undefined,
  };
}

export function hydrateTickerMetadata(data: Record<string, unknown>): TickerMetadata {
  const rawPositions = Array.isArray(data.positions) ? data.positions : [];
  return {
    ...DEFAULT_TICKER_METADATA,
    ticker: (data.ticker as string) ?? "",
    exchange: (data.exchange as string) ?? "",
    currency: (data.currency as string) ?? "USD",
    name: (data.name as string) ?? "",
    sector: data.sector as string | undefined,
    industry: data.industry as string | undefined,
    assetCategory: (data.assetCategory ?? data.asset_category) as string | undefined,
    isin: data.isin as string | undefined,
    cusip: data.cusip as string | undefined,
    portfolios: Array.isArray(data.portfolios) ? [...data.portfolios] : [],
    watchlists: Array.isArray(data.watchlists) ? [...data.watchlists] : [],
    positions: rawPositions.map((position) => hydratePosition(position as Record<string, unknown>)),
    broker_contracts: Array.isArray(data.broker_contracts) ? [...data.broker_contracts] : [],
    custom: data.custom && typeof data.custom === "object" ? { ...(data.custom as Record<string, unknown>) } : {},
    tags: Array.isArray(data.tags) ? [...data.tags] : [],
    ...hydrateMergedLots(data.mergedLots),
  };
}

/** The merged-lots record, kept only as a map of keys to lists of strings. */
function hydrateMergedLots(raw: unknown): Pick<TickerMetadata, "mergedLots"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((lot) => typeof lot === "string"))
    .map(([key, lots]): [string, string[]] => [key, [...lots]]);
  return entries.length > 0 ? { mergedLots: Object.fromEntries(entries) } : {};
}
