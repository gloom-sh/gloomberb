import { useCallback } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { ActionRow } from "../../../components";
import { useAsyncResource, useAutoRefresh, usePluginAppActions } from "../../../public/react";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { perpEquityIdentity } from "./equity-identity";
import { loadPerpsEquity } from "./client";
import { compact, percent, perpDescription, price, readingTime } from "./model";

/** A failed optional market comparison never blocks a stock's quote. */
export function PerpEquityRow({ symbol, exchange, instrumentType, maxRows = 3 }: { symbol: string; exchange?: string; instrumentType?: string; maxRows?: number }) {
  const session = useResearchCloudSession();
  const plan = usePlanAccess();
  const { createPaneFromTemplate } = usePluginAppActions();
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
  return <>{rows.slice(0, maxRows).map((row) => {
    const read = readingTime(row.observedAt);
    return <ActionRow key={row.marketId} height={2}
      // Funding reads per 8h here as it does in PERP, whatever interval the venue pays on.
      label={`${row.baseAsset} · ${perpDescription(row)}  ${price(row.markPrice)} ${row.quoteCurrency}  ${percent(row.underlyingPremium, 2)} vs last${row.stale || resource.data?.stale ? " · stale" : ""}\nFunding ${percent(row.fundingRate8h, 4)} per 8 h · OI ${compact(row.openInterestUsd)} USD · oracle ${percent(row.premium, 2)}${read ? ` · as of ${read}` : ""}`}
      onPress={() => createPaneFromTemplate("perps-pane", { arg: row.marketId })} />;
  })}</>;
}
