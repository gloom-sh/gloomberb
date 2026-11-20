import { useEffect, useState } from "react";
import { isAccessDenied } from "../../../../api-client/errors";
import { usePaneFooter } from "../../../../components";
import { t } from "../../../../i18n";
import { useAsyncResource } from "../../../../react/async-resource";
import { useAutoRefresh } from "../../../../react/auto-refresh";
import { usePaneVisible } from "../../../../state/app/activity";
import { usePaneAppConfig } from "../../../../state/app/context";
import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { cryptoPluginMeta } from "../../builtin-plugin-meta";
import { CRYPTO_OVERVIEW_REFRESH_MS, loadCryptoMarketsForOverview } from "../../crypto-board/client";
import { coinIdentityOf, findCoinAsset } from "../../crypto-board/coin";

export function useCoinOverview(ticker: TickerRecord | null, financials: TickerFinancials | null, focused: boolean) {
  const config = usePaneAppConfig();
  const identity = config.disabledPlugins.includes(cryptoPluginMeta.id) ? null : coinIdentityOf({ ticker, financials });
  const enabled = identity !== null;
  const visible = usePaneVisible();
  const [opened, setOpened] = useState(false);
  const { data, error, load, reload, updatedAt, savedAt } = useAsyncResource(enabled ? loadCryptoMarketsForOverview : null, {
    manual: true,
    clearOnError: isAccessDenied,
  });
  useEffect(() => {
    if (!enabled) setOpened(false);
    else if (visible && !opened) {
      setOpened(true);
      load();
    }
  }, [enabled, visible, opened, load]);
  useAutoRefresh(updatedAt, reload, { enabled: enabled && focused, intervalMs: CRYPTO_OVERVIEW_REFRESH_MS });
  usePaneFooter("crypto-overview", () => error && savedAt === null ? {
    info: [{ id: "refresh", parts: [{ text: t("Couldn't refresh"), tone: "warning" }] }],
  } : null, [error, savedAt]);
  return identity && data ? findCoinAsset(data.payload.assets, identity.code) : null;
}
