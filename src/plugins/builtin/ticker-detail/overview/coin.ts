import { useEffect } from "react";
import { isAccessDenied } from "../../../../api-client/errors";
import type { CryptoMarketAsset } from "../../../../api-client/crypto-markets";
import { usePaneFooter } from "../../../../components";
import { useAsyncResource } from "../../../../react/async-resource";
import { useUpdatedAgo } from "../../../../react/auto-refresh";
import { usePaneVisible } from "../../../../state/app/activity";
import { usePaneAppConfig } from "../../../../state/app/context";
import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { formatCompactAmount, formatCompactCurrency } from "../../../../utils/format";
import { cachedCryptoMarkets, loadCryptoMarkets } from "../../crypto-board/client";
import { coinIdentityOf, findCoinAsset } from "../../crypto-board/coin";
import type { StatField } from "./types";

/** The board supplies only figures the ticker's own overview may not have. */
export function coinOverviewStats(asset: CryptoMarketAsset): StatField[] {
  const fields: StatField[] = [];
  if (asset.volume24h != null) fields.push({ label: "Volume", value: formatCompactCurrency(asset.volume24h, "USD", { fixedDecimals: true }), detail: "24h" });
  if (asset.marketCap != null) fields.push({ label: "Market Cap", value: formatCompactCurrency(asset.marketCap, "USD", { fixedDecimals: true }) });
  if (asset.circulatingSupply != null) fields.push({ label: "Circulating", value: formatCompactAmount(asset.circulatingSupply) });
  if (asset.maxSupply != null) fields.push({ label: "Max Supply", value: formatCompactAmount(asset.maxSupply) });
  if (asset.rank > 0) fields.push({ label: "Rank", value: `#${asset.rank}`, detail: "by market cap" });
  return fields;
}

export function useCoinOverviewStats(ticker: TickerRecord | null, financials: TickerFinancials | null, focused: boolean): StatField[] {
  const config = usePaneAppConfig();
  const identity = !config.disabledPlugins.includes("crypto") ? coinIdentityOf({ ticker, financials }) : null;
  const resource = useAsyncResource(identity ? loadCryptoMarkets : null, { initialData: cachedCryptoMarkets, clearOnError: isAccessDenied });
  const visible = usePaneVisible();
  const load = resource.load;
  useEffect(() => {
    if (!identity || !visible || !focused) return;
    const timer = setInterval(() => load(false), 15_000);
    return () => clearInterval(timer);
  }, [identity?.code, focused, visible, load]);
  const generatedAt = resource.data?.payload.generatedAt;
  const age = useUpdatedAgo(generatedAt ? Date.parse(generatedAt) : null);
  usePaneFooter("crypto-overview", () => ({ info: [
    ...(resource.data && (resource.error || resource.data.refreshError) ? [{ id: "refresh", parts: [{ text: "crypto refresh failed", tone: "warning" as const }] }] : []),
    ...(resource.data?.stale ? [{ id: "cached", parts: [{ text: "crypto cached", tone: "warning" as const }] }] : []),
    ...(age ? [{ id: "crypto-age", asOf: true, parts: [{ text: `crypto data ${age}`, tone: "muted" as const }] }] : []),
  ] }), [resource.data, resource.error, age]);
  const asset = identity && resource.data ? findCoinAsset(resource.data.payload.assets, identity.code) : null;
  return asset ? coinOverviewStats(asset) : [];
}
