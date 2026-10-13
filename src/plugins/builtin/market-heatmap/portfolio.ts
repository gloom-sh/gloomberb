import { useEffect, useMemo } from "react";
import type { MarketHeatmapAsset, MarketHeatmapUniverseId } from "../../../api-client/market-discovery";
import { useAppSelector, usePaneStateValue } from "../../../state/app/context";
import type { ColumnConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
import {
  getRegularSessionMoveDisplay,
  getTradedSessionMoveDisplay,
  type ActiveQuoteDisplay,
  type ExtendedSession,
} from "../../../market-data/market/status";
import type { TickerRecord } from "../../../types/ticker";
import { getSortValue, type ColumnContext } from "../portfolio-list/metrics";

export const PORTFOLIO_HEATMAP_TAB = "portfolio";

/**
 * How a market board's tile area follows size. The day's move, the default on
 * the market boards, makes the movers the big tiles whatever their company's
 * size; the square root of market cap gives mid-size names room next to the
 * largest. Groups still sum their tiles, so a sector's block stays the sum of
 * its names' weights. Portfolio holdings always take their position value as
 * it is.
 */
export type HeatmapSizeBy = "day-move" | "market-cap" | "sqrt-market-cap";

const SIZE_BY_VALUES: readonly HeatmapSizeBy[] = ["day-move", "market-cap", "sqrt-market-cap"];

/**
 * What a pane that never chose sizes by: the day's move on the market boards,
 * and the square root of market cap on a watchlist, which keeps the sizing it
 * had.
 */
function defaultHeatmapSizeBy(universe: unknown): HeatmapSizeBy {
  return heatmapTabId(typeof universe === "string" ? universe : null) === PORTFOLIO_HEATMAP_TAB
    ? "sqrt-market-cap"
    : "day-move";
}

/** A saved choice wins; a pane that never chose gets its board's default. */
export function heatmapSizeBy(value: unknown, universe?: unknown): HeatmapSizeBy {
  return SIZE_BY_VALUES.find((option) => option === value) ?? defaultHeatmapSizeBy(universe);
}

/**
 * A move smaller than this, in percentage points, or none at all, takes the
 * smallest tile: a flat name stays on the map and the layout never has a
 * zero-area tile to place.
 */
export const DAY_MOVE_FLOOR_PERCENT = 0.25;

/**
 * The weight of a name sized by its day move: the square root of the move's
 * size, up or down alike, with the floor above. The root keeps a few outsized
 * movers from taking the board: a +10% name gets about three times the area of
 * a +1% one, not ten.
 */
export function dayMoveWeight(move: number | null | undefined): number {
  const size = typeof move === "number" && Number.isFinite(move) ? Math.abs(move) : 0;
  return Math.sqrt(Math.max(size, DAY_MOVE_FLOOR_PERCENT));
}

/**
 * A name's tile weight. `marketCap` is the size the snapshot carries (a fund's
 * net assets), `move` the move its tile is coloured by, or null when it has
 * none: the day's move ignores the first and market cap the second.
 */
export function heatmapSizeWeight(
  sizeBy: HeatmapSizeBy,
  { marketCap, move }: { marketCap: number; move: number | null | undefined },
): number {
  if (sizeBy === "day-move") return dayMoveWeight(move);
  return sizeBy === "sqrt-market-cap" ? Math.sqrt(marketCap) : marketCap;
}
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
  /** The price and move are this open pre-market or after-hours session's, from the regular close. */
  extendedSession?: ExtendedSession;
}

export interface HeatmapPortfolioPane {
  instanceId: string;
  collectionId: string | null;
}

export function heatmapTabId(value: string | null | undefined): HeatmapTabId {
  if (value === "us-equity" || value === "us-etf" || value === PORTFOLIO_HEATMAP_TAB) return value;
  return "us-equity";
}

/** Pane state where the pane says which kind of list its portfolio tab shows, for the header to read. */
export const HEATMAP_COLLECTION_KIND_STATE_KEY = "collectionKind";

/**
 * Whether Size by changes the board: the market boards and a watchlist, never
 * a portfolio, whose holdings are always sized by position value. Until the
 * pane has said which list its tab shows, the control stays away.
 */
export function heatmapSizeByApplies(universe: unknown, collectionKind: unknown): boolean {
  return heatmapTabId(typeof universe === "string" ? universe : null) !== PORTFOLIO_HEATMAP_TAB
    || collectionKind === "watchlist";
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
 * the portfolio's currency, which a holder reads linearly whatever `sizeBy`
 * says. A watchlist's names follow `sizeBy`: market cap in the base currency,
 * by default its square root, or the day's move. A name with no size (no
 * position, no quote, no cap, no FX rate) gets the smallest tile and no
 * caption; sized by the day's move, a name is sized by its move whether or not
 * it has a cap. Past `MAX_PORTFOLIO_TILES`, the smallest tiles' names are left
 * out and counted in `omitted`.
 */
export function buildPortfolioHeatmapAssets({
  tickers,
  financials,
  collectionId,
  kind,
  currency,
  exchangeRates,
  sizeBy = "sqrt-market-cap",
  regularSession = false,
}: {
  tickers: readonly TickerRecord[];
  financials: ReadonlyMap<string, TickerFinancials>;
  collectionId: string;
  kind: "portfolio" | "watchlist";
  /** The portfolio's totals currency, or the base currency for a watchlist. */
  currency: string;
  exchangeRates: Map<string, number>;
  sizeBy?: HeatmapSizeBy;
  /** Color by the regular session alone, never an extended print (`getRegularSessionMoveDisplay`). */
  regularSession?: boolean;
}): { assets: HeatmapBoardAsset[]; omitted: number } {
  const context: ColumnContext = {
    activeTab: kind === "portfolio" ? collectionId : undefined,
    baseCurrency: currency,
    exchangeRates,
    now: 0,
  };
  const sizeColumn = kind === "portfolio" ? MARKET_VALUE_COLUMN : MARKET_CAP_COLUMN;
  const byMove = kind === "watchlist" && sizeBy === "day-move";
  const measured: HeatmapBoardAsset[] = tickers.map((ticker) => {
    const symbol = ticker.metadata.ticker;
    const snapshot = financials.get(symbol);
    const quote = snapshot?.quote;
    // Colored like the market boards: an open extended session's move, else the regular session's.
    const display: (ActiveQuoteDisplay & { session?: ExtendedSession }) | null = regularSession
      ? getRegularSessionMoveDisplay(quote)
      : getTradedSessionMoveDisplay(quote);
    const price = display != null && Number.isFinite(display.price) ? display.price : null;
    const size = positiveNumber(getSortValue(sizeColumn, ticker, snapshot, context));
    const hasChange = display?.changePercent != null && Number.isFinite(display.changePercent);
    const move = hasChange ? display!.changePercent : null;
    return {
      symbol,
      name: quote?.name?.trim() || ticker.metadata.name || symbol,
      price: price ?? 0,
      change: display?.change != null && Number.isFinite(display.change) ? display.change : 0,
      changePercent: hasChange ? display.changePercent! : 0,
      hasChange,
      ...(display?.session ? { extendedSession: display.session } : {}),
      size,
      weight: byMove
        ? dayMoveWeight(move)
        : size == null ? undefined : kind === "portfolio" ? size : heatmapSizeWeight(sizeBy, { marketCap: size, move }),
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

  const rank = (asset: HeatmapBoardAsset) => (byMove ? asset.weight : asset.size) ?? 0;
  measured.sort((left, right) => rank(right) - rank(left) || (right.size ?? 0) - (left.size ?? 0) || left.symbol.localeCompare(right.symbol));
  const kept = measured.slice(0, MAX_PORTFOLIO_TILES);
  const sizes = kept.flatMap((asset) => (asset.size != null ? [asset.size] : []));
  const floor = sizes.length > 0 ? Math.min(...sizes) : 1;
  const floorWeight = kind === "portfolio" ? floor : heatmapSizeWeight(sizeBy, { marketCap: floor, move: null });
  return {
    assets: kept.map((asset) => (asset.size != null || byMove ? asset : { ...asset, weight: floorWeight })),
    omitted: measured.length - kept.length,
  };
}
