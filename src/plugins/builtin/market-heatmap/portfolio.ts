import { useEffect, useMemo } from "react";
import type { MarketHeatmapAsset, MarketHeatmapUniverseId } from "../../../api-client/market-discovery";
import { useAppSelector, usePaneStateValue } from "../../../state/app/context";
import type { ColumnConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { getSortValue, type ColumnContext } from "../portfolio-list/metrics";

export const PORTFOLIO_HEATMAP_TAB = "portfolio";
const MAX_PORTFOLIO_TILES = 160;

export type HeatmapTabId = MarketHeatmapUniverseId | typeof PORTFOLIO_HEATMAP_TAB;

export interface HeatmapBoardAsset extends MarketHeatmapAsset {
  /** False when the tile has no size of its own. The caption must not invent one. */
  showSize?: boolean;
  sizeCaption?: "Value";
  /** The currency `size` is in, when it is not the quote's. */
  sizeCurrency?: string;
  /** Treemap area, when it is not `size` itself. */
  weight?: number;
}

export interface HeatmapPortfolioPane {
  instanceId: string;
  collectionId: string | null;
}

export function heatmapTabId(value: string | null | undefined): HeatmapTabId {
  if (value === "us-equity" || value === "us-etf" || value === PORTFOLIO_HEATMAP_TAB) return value;
  return "us-equity";
}

export function isRemoteHeatmapUniverse(value: HeatmapTabId): value is MarketHeatmapUniverseId {
  return value !== PORTFOLIO_HEATMAP_TAB;
}

/**
 * A linked heatmap changes tab only after the portfolio pane moves from one
 * list to another. The first id, including one that arrives after mount, is
 * the list already selected.
 */
export function heatmapFollowsCollection(
  linked: boolean,
  previous: string | null,
  next: string | null,
): boolean {
  return linked && previous != null && next != null && previous !== next;
}

export function heatmapCollectionLabel(
  config: { portfolios: readonly { id: string; name: string }[]; watchlists: readonly { id: string; name: string }[] },
  collectionId: string | null,
): string {
  if (!collectionId) return "Portfolio";
  return config.portfolios.find((portfolio) => portfolio.id === collectionId)?.name
    ?? config.watchlists.find((watchlist) => watchlist.id === collectionId)?.name
    ?? "Portfolio";
}

export function fallbackHeatmapCollectionId(
  config: { portfolios: readonly { id: string }[]; watchlists: readonly { id: string }[] },
): string | null {
  return config.portfolios[0]?.id ?? config.watchlists[0]?.id ?? null;
}

export function heatmapPortfolioPanes(
  instances: readonly { instanceId: string; paneId: string; params?: Record<string, string> | undefined }[],
  paneState: Record<string, { collectionId?: unknown } | undefined>,
): HeatmapPortfolioPane[] {
  return instances.flatMap((instance) => {
    if (instance.paneId !== "portfolio-list") return [];
    const fromState = paneState[instance.instanceId]?.collectionId;
    const collectionId = typeof fromState === "string" && fromState
      ? fromState
      : instance.params?.collectionId || null;
    return [{ instanceId: instance.instanceId, collectionId }];
  });
}

/** The portfolio pane the user is on, else the one this heatmap last followed. */
export function resolveHeatmapPortfolioSource(
  panes: readonly HeatmapPortfolioPane[],
  focusedPaneId: string | null,
  rememberedSourceId: string | null,
): HeatmapPortfolioPane | null {
  if (panes.length === 0) return null;
  const focused = focusedPaneId ? panes.find((pane) => pane.instanceId === focusedPaneId) : undefined;
  if (focused) return focused;
  const remembered = rememberedSourceId ? panes.find((pane) => pane.instanceId === rememberedSourceId) : undefined;
  return remembered ?? panes[0] ?? null;
}

export function heatmapPortfolioSignature(state: {
  focusedPaneId: string | null;
  config: { layout: { instances: readonly { instanceId: string; paneId: string; params?: Record<string, string> }[] } };
  paneState: Record<string, { collectionId?: unknown } | undefined>;
}): string {
  const panes = heatmapPortfolioPanes(state.config.layout.instances, state.paneState);
  return `${state.focusedPaneId ?? ""}\n${panes.map((pane) => `${pane.instanceId}=${pane.collectionId ?? ""}`).join("\n")}`;
}

export function parseHeatmapPortfolioSignature(signature: string): {
  focusedPaneId: string | null;
  panes: HeatmapPortfolioPane[];
} {
  const [focused = "", ...rows] = signature.split("\n");
  return {
    focusedPaneId: focused || null,
    panes: rows.filter((row) => row.length > 0).map((row) => {
      const splitAt = row.indexOf("=");
      const collectionId = row.slice(splitAt + 1);
      return {
        instanceId: splitAt >= 0 ? row.slice(0, splitAt) : row,
        collectionId: collectionId || null,
      };
    }),
  };
}

export function useLinkedHeatmapCollection(): { collectionId: string | null; sourceInstanceId: string | null } {
  const [remembered, setRemembered] = usePaneStateValue<string>("portfolioSourceId", "");
  const signature = useAppSelector(heatmapPortfolioSignature);
  const resolved = useMemo(() => {
    const { focusedPaneId, panes } = parseHeatmapPortfolioSignature(signature);
    return resolveHeatmapPortfolioSource(panes, focusedPaneId, remembered || null);
  }, [remembered, signature]);

  useEffect(() => {
    const next = resolved?.instanceId ?? "";
    if (next !== remembered) setRemembered(next);
  }, [remembered, resolved, setRemembered]);

  return {
    collectionId: resolved?.collectionId ?? null,
    sourceInstanceId: resolved?.instanceId ?? null,
  };
}

const MARKET_VALUE_COLUMN: ColumnConfig = { id: "mkt_value", label: "Mkt Value", width: 10, align: "right" };
const MARKET_CAP_COLUMN: ColumnConfig = { id: "market_cap", label: "Mkt Cap", width: 10, align: "right" };

function positiveNumber(value: number | string | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A portfolio's holdings are sized by market value, read as the portfolio pane
 * reads its MKT VALUE column: lots, contract multipliers and price basis, in
 * the portfolio's currency. A watchlist's names are sized by the square root
 * of market cap in the base currency, so a mega-cap does not hide the rest of
 * a short list. A name with no size (no position, no quote, no cap, no FX
 * rate) gets the smallest tile and no caption. Past `MAX_PORTFOLIO_TILES`,
 * the smallest names are left out and counted in `omitted`.
 */
export function buildPortfolioHeatmapAssets({
  tickers,
  financials,
  collectionId,
  kind,
  currency,
  exchangeRates,
}: {
  tickers: readonly TickerRecord[];
  financials: ReadonlyMap<string, TickerFinancials>;
  collectionId: string;
  kind: "portfolio" | "watchlist";
  /** The portfolio's totals currency, or the base currency for a watchlist. */
  currency: string;
  exchangeRates: Map<string, number>;
}): { assets: HeatmapBoardAsset[]; omitted: number } {
  const context: ColumnContext = {
    activeTab: kind === "portfolio" ? collectionId : undefined,
    baseCurrency: currency,
    exchangeRates,
    now: 0,
  };
  const sizeColumn = kind === "portfolio" ? MARKET_VALUE_COLUMN : MARKET_CAP_COLUMN;
  const measured: HeatmapBoardAsset[] = tickers.map((ticker) => {
    const symbol = ticker.metadata.ticker;
    const snapshot = financials.get(symbol);
    const quote = snapshot?.quote;
    const price = quote != null && Number.isFinite(quote.price) ? quote.price : null;
    const size = positiveNumber(getSortValue(sizeColumn, ticker, snapshot, context));
    const hasChange = quote != null && Number.isFinite(quote.changePercent);
    return {
      symbol,
      name: quote?.name?.trim() || ticker.metadata.name || symbol,
      price: price ?? 0,
      change: quote != null && Number.isFinite(quote.change) ? quote.change : 0,
      changePercent: hasChange ? quote.changePercent : 0,
      hasChange,
      size,
      weight: size == null ? undefined : kind === "portfolio" ? size : Math.sqrt(size),
      sizeKind: "market-cap",
      sizeCaption: kind === "portfolio" ? "Value" : undefined,
      sizeCurrency: currency,
      showSize: size != null,
      volume: typeof quote?.volume === "number" && Number.isFinite(quote.volume) ? quote.volume : null,
      currency: quote?.currency || ticker.metadata.currency || currency,
      exchange: ticker.metadata.exchange || "",
      sector: ticker.metadata.sector ?? null,
      industry: ticker.metadata.industry ?? null,
      marketState: quote?.marketState ?? null,
      source: "gloom",
    };
  });

  measured.sort((left, right) => (
    (right.size ?? 0) - (left.size ?? 0) || left.symbol.localeCompare(right.symbol)
  ));
  const kept = measured.slice(0, MAX_PORTFOLIO_TILES);
  const sizes = kept.flatMap((asset) => (asset.size != null ? [asset.size] : []));
  const floor = sizes.length > 0 ? Math.min(...sizes) : 1;
  const floorWeight = kind === "portfolio" ? floor : Math.sqrt(floor);
  return {
    assets: kept.map((asset) => (asset.size != null ? asset : { ...asset, weight: floorWeight })),
    omitted: measured.length - kept.length,
  };
}
