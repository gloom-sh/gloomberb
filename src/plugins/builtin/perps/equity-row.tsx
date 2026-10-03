import { useCallback } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { ActionRow } from "../../../components";
import { useAsyncResource, useAutoRefresh, usePluginAppActions } from "../../../public/react";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { listingIdentity } from "../shared/ticker-request";
import { loadPerpsEquity } from "./client";
import { fundingInterval, marketLabel, percent, price, time } from "./model";

/** A failed optional market comparison never blocks a stock's quote. */
export function PerpEquityRow({ symbol, instrumentType }: { symbol: string; instrumentType?: string }) {
  const session = useResearchCloudSession();
  const plan = usePlanAccess();
  const { createPaneFromTemplate } = usePluginAppActions();
  const identity = listingIdentity(symbol)?.symbol;
  const enabled = !!identity && ["STK", "EQUITY", "STOCK"].includes(instrumentType?.toUpperCase() ?? "");
  const accessKey = `${session.requestKey}:${plan.hasProAccess ? "pro" : "preview"}`;
  const loader = useCallback((force: boolean) => loadPerpsEquity(identity!, accessKey, force), [identity, accessKey]);
  const resource = useAsyncResource(enabled ? loader : null, { clearOnError: isAccessDenied });
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  const rows = resource.data?.payload.rows.filter((row) => !row.delisted) ?? [];
  if (!enabled || !rows.length) return null;
  return <>{rows.slice(0, 3).map((row) => <ActionRow key={row.marketId} label={`Perp ${marketLabel(row)} · ${price(row.markPrice)} ${row.quoteCurrency} · ${percent(row.underlyingPremium, 2)} vs last · ${percent(row.fundingRate, 5)} / ${fundingInterval(row)} · ${row.stale ? "stale " : ""}${time(row.observedAt)}`}
    onPress={() => createPaneFromTemplate("perps-pane", { arg: row.marketId })} />)}</>;
}
