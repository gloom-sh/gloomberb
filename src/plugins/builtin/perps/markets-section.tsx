import { useCallback, useMemo, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { PerpBoardRow } from "../../../api-client/perps";
import { ActionRow, ColumnGrid, SectionHeading, type ColumnGridCell, type ColumnGridColumn } from "../../../components";
import { t, tf } from "../../../i18n";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { perpetualListing } from "../../../tickers/perpetual-listing";
import { Box, Text } from "../../../ui";
import { isRoundTheClockCoin } from "../../../utils/crypto-pair";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadPerpsCompare, loadPerpsEquity } from "./client";
import { perpEquityIdentity } from "./equity-identity";
import { useLivePerpRows } from "./live-rows";
import { compact, perpCell, percent, price, readingTime, venueName } from "./model";
import { useOpenPerpMarket } from "./open-market";
import { contractText, foldSmallMarkets, mergeVenueMarkets, type PerpVenueMarket } from "./venue-markets";

const STOCK_TYPES = new Set(["STK", "EQUITY", "STOCK", "COMMON STOCK"]);
const COIN_PAIR = /^([A-Z0-9]{1,15})[-/](?:USD|USDT|USDC)$/;

/** What an asset's contracts are looked up by: a stock's listing, or a coin's base asset. Null for a contract itself. */
function perpAsset(symbol: string, exchange: string | undefined, instrumentType: string | undefined):
  { kind: "stock"; symbol: string; exchange: string } | { kind: "coin"; base: string } | null {
  if (perpetualListing(symbol, exchange)) return null;
  if (isRoundTheClockCoin(symbol, exchange)) {
    const bare = parsePublicTickerKey(symbol).symbol.toUpperCase();
    const base = COIN_PAIR.exec(bare)?.[1] ?? (/^[A-Z0-9]{1,15}$/.test(bare) ? bare : null);
    return base ? { kind: "coin", base } : null;
  }
  const identity = perpEquityIdentity(symbol, exchange);
  return identity && STOCK_TYPES.has(instrumentType?.toUpperCase() ?? "") ? { kind: "stock", ...identity } : null;
}

interface Column { id: "venue" | "contract" | "mark" | "premium" | "funding" | "oi" | "volume"; label: string; width: number; align?: "right"; minWidth?: number }
// Reading order; a narrow overview gives up the volume, then the contract, then the premium.
const COLUMNS: readonly Column[] = [
  { id: "venue", label: "Venue", width: 11 },
  { id: "contract", label: "Contract", width: 11, minWidth: 68 },
  { id: "mark", label: "Mark", width: 11, align: "right" },
  { id: "premium", label: "Premium", width: 8, align: "right", minWidth: 50 },
  { id: "funding", label: "Fund 8h", width: 9, align: "right" },
  { id: "oi", label: "OI USD", width: 7, align: "right" },
  { id: "volume", label: "Vol 24h", width: 7, align: "right", minWidth: 76 },
];
const GAP = 2;

/**
 * DES's perpetual markets on a stock or a coin: one row per venue (its contracts merged, `venue-markets.ts`), the
 * deepest first, markets with a small share of the open interest folded behind a row that shows them. A row opens
 * PERP on its venue's deepest contract. The figures move with the quote stream while the venue streams; otherwise
 * the section says when the venues were read.
 */
export function PerpMarketsSection({ symbol, exchange, instrumentType, width }: { symbol: string; exchange?: string; instrumentType?: string; width: number }) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  const plan = usePlanAccess();
  const openMarket = useOpenPerpMarket();
  const [expanded, setExpanded] = useState(false);
  const asset = perpAsset(symbol, exchange, instrumentType);
  const assetKey = asset ? asset.kind === "coin" ? `coin:${asset.base}` : `stock:${asset.symbol}:${asset.exchange}` : null;
  const accessKey = `${session.requestKey}:${plan.hasProAccess ? "pro" : "preview"}`;
  const loader = useCallback((force: boolean) => {
    const [kind, first, second] = assetKey!.split(":");
    return kind === "coin" ? loadPerpsCompare(first!, accessKey, force) : loadPerpsEquity({ symbol: first!, exchange: second! }, accessKey, force);
  }, [assetKey, accessKey]);
  const resource = useAsyncResource(assetKey ? loader : null, { clearOnError: isAccessDenied });
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  const markets = useMemo(() => mergeVenueMarkets(resource.data?.payload.rows ?? []), [resource.data]);
  const { shown, folded } = useMemo(() => foldSmallMarkets(markets), [markets]);
  const visible = expanded ? markets : shown;
  // The deepest contract of each row on screen follows the quote stream.
  const primaries = useMemo(() => visible.map((market) => market.primary), [visible]);
  const live = useLivePerpRows(primaries, { surface: "detail" });
  if (!assetKey || !markets.length) return null;
  const rows = visible.map((market, index) => ({ market, row: live.rows[index] ?? market.primary }));
  const premiumLabel = asset?.kind === "stock" ? "vs last" : "Premium";
  const columns = COLUMNS.filter((column) => width >= (column.minWidth ?? 0));
  const fixed = columns.reduce((sum, column) => sum + column.width, 0) + GAP * (columns.length - 1);
  // The last text column takes what the figures leave, on the desktop too, so a venue keeps its contract beside it.
  const growing = columns.some((column) => column.id === "contract") ? "contract" : "venue";
  const gridColumns: ColumnGridColumn[] = columns.map((column, index) => ({
    width: column.id === growing ? Math.max(column.width, width - fixed + column.width) : column.width,
    align: column.align,
    gapBefore: index > 0 ? GAP : 0,
    ...(column.id === growing ? { growFrom: column.width } : {}),
  }));
  const header: ColumnGridCell[] = columns.map((column) => ({ text: t(column.id === "premium" ? premiumLabel : column.label), color: colors.textDim }));
  const cell = (column: Column, market: PerpVenueMarket, row: PerpBoardRow): ColumnGridCell => {
    if (column.id === "venue") {
      return { text: venueName(market.venue), color: row.stale ? colors.textDim : colors.textBright,
        link: { label: tf("Open {label}", { label: `PERP ${row.baseAsset} · ${venueName(market.venue)}` }), onOpen: () => openMarket(row.marketId) } };
    }
    if (column.id === "contract") return { text: contractText(market), color: colors.textMuted };
    if (column.id === "mark") return { text: price(row.markPrice ?? row.lastPrice), color: colors.text };
    if (column.id === "premium") {
      const value = asset?.kind === "stock" ? row.underlyingPremium : row.premium;
      return { text: percent(value, 2), color: value == null || value === 0 ? colors.textMuted : value > 0 ? colors.positive : colors.negative };
    }
    if (column.id === "funding") {
      const { text, color } = perpCell(row, "fundingRate8h", colors);
      return { text, color };
    }
    // A venue's open interest and volume are its contracts' together.
    return { text: compact(column.id === "oi" ? market.openInterestUsd : market.volume24hUsd), color: colors.text };
  };
  const body = rows.map(({ market, row }) => columns.map((column) => cell(column, market, row)));
  // Streaming figures date themselves; a read says when.
  const read = live.live ? null : readingTime(rows.reduce<string | null>((latest, { row }) => !latest || row.observedAt > latest ? row.observedAt : latest, null));
  const stale = !live.live && (!!resource.data?.stale || rows.some(({ row }) => row.stale));
  return (
    <Box flexDirection="column" data-gloom-role="perp-markets">
      <SectionHeading title={t("Perpetuals")} />
      <ColumnGrid columns={gridColumns} rows={[header, ...body]} width={width} role="perp-markets-grid" />
      {folded.length > 0 && (
        <ActionRow expanded={expanded} width={width}
          label={expanded ? t("Fewer markets") : folded.length === 1 ? t("1 smaller market") : tf("{count} smaller markets", { count: String(folded.length) })}
          onPress={() => setExpanded((value) => !value)} />
      )}
      {read && <Text fg={stale ? colors.warning : colors.textDim}>{`${t("as of")} ${read}${stale ? ` · ${t("stale")}` : ""}`}</Text>}
    </Box>
  );
}
