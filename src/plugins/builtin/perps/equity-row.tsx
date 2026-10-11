import { useCallback } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { PerpBoardRow } from "../../../api-client/perps";
import { ActionRow, usePaneLinkMenuEntry } from "../../../components";
import { displayWidth } from "../../../utils/format";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { perpEquityIdentity } from "./equity-identity";
import { loadPerpsEquity } from "./client";
import { compact, percent, perpDescription, price, readingTime } from "./model";
import { openPerpLabel, useOpenPerpMarket } from "./open-market";

/** A failed optional market comparison never blocks a stock's quote. */
export function PerpEquityRow({ symbol, exchange, instrumentType, maxRows = 3, width }: {
  symbol: string; exchange?: string; instrumentType?: string; maxRows?: number;
  /** Columns the row has, in a narrow card: the contract gets its short name and the least read figures go first. */
  width?: number;
}) {
  const session = useResearchCloudSession();
  const plan = usePlanAccess();
  const identity = perpEquityIdentity(symbol, exchange);
  const listingSymbol = identity?.symbol;
  const listingExchange = identity?.exchange;
  const enabled = !!identity && ["STK", "EQUITY", "STOCK", "COMMON STOCK"].includes(instrumentType?.toUpperCase() ?? "");
  const accessKey = `${session.requestKey}:${plan.hasProAccess ? "pro" : "preview"}`;
  const loader = useCallback((force: boolean) => loadPerpsEquity({ symbol: listingSymbol!, exchange: listingExchange! }, accessKey, force), [listingSymbol, listingExchange, accessKey]);
  const resource = useAsyncResource(enabled ? loader : null, { clearOnError: isAccessDenied });
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  const rows = resource.data?.payload.rows.filter((row) => !row.delisted) ?? [];
  if (!enabled || !rows.length) return null;
  return <>{rows.slice(0, maxRows).map((row) => <PerpRow key={row.marketId} row={row} stale={!!resource.data?.stale} width={width} />)}</>;
}

/** The parts that fit `width`, dropped from the end; all of them when the width is not known. */
function fitParts(parts: string[], separator: string, width: number | undefined): string {
  let kept = parts;
  while (width !== undefined && kept.length > 1 && displayWidth(kept.join(separator)) > width) kept = kept.slice(0, -1);
  return kept.join(separator);
}

/** One contract on the stock: a click, or its entry in the pane menu, opens PERP on that market. */
function PerpRow({ row, stale, width }: { row: PerpBoardRow; stale: boolean; width?: number }) {
  const openMarket = useOpenPerpMarket();
  const open = () => openMarket(row.marketId);
  usePaneLinkMenuEntry(`function:perps-pane:${row.marketId}`, openPerpLabel(row), open);
  const read = readingTime(row.observedAt);
  const figures = [`${price(row.markPrice)} ${row.quoteCurrency}`, `${percent(row.underlyingPremium, 2)} vs last${row.stale || stale ? " · stale" : ""}`];
  const named = [`${row.baseAsset} · ${perpDescription(row)}`, ...figures].join("  ");
  const first = width === undefined || displayWidth(named) <= width ? named : [`${row.baseAsset} perpetual`, ...figures].join("  ");
  // Funding reads per 8h here as it does in PERP, whatever interval the venue pays on.
  const second = fitParts([`Funding ${percent(row.fundingRate8h, 4)} per 8 h`, `OI ${compact(row.openInterestUsd)} USD`, `oracle ${percent(row.premium, 2)}`,
    ...(read ? [`as of ${read}`] : [])], " · ", width);
  return <ActionRow height={2} label={`${first}\n${second}`} onPress={open} />;
}
