import { ActionRow } from "../../../components/ui/action-row";
import { Box, ScrollBox, Text } from "../../../ui";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../../i18n";
import type { AppState } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { BrokerConnectionStatus } from "../../../types/broker";
import type { Portfolio } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { formatCompact, padTo } from "../../../utils/format";
import { isPlainKey, type KeyboardModifierEventLike } from "../../../utils/keyboard";
import { formatMarketQuantity } from "../../../market-data/market/format";
import { getBrokerInstance } from "../../../utils/broker-instances";
import { usePluginBrokerActions } from "../../runtime";
import {
  renderSummarySegments,
  resolvePortfolioAccountState,
  type PortfolioSummarySegment,
  type ResolvedPortfolioAccountState,
} from "./summary";

/** Only a bare `c`: Cmd+Shift+C copies a pane screenshot and must not open the drawer on the way. */
export function shouldToggleCashMarginDrawer(event: KeyboardModifierEventLike, showCashDrawer: boolean): boolean {
  return showCashDrawer && isPlainKey(event, "c");
}

export interface PortfolioAccountStateResult {
  accountState: ResolvedPortfolioAccountState | null;
  /** Set when the broker refused to list accounts, so "no cash" is not mistaken for a clean empty. */
  accountsError: string | null;
}

export function usePortfolioAccountState(
  portfolio: Portfolio | null,
  state: Pick<AppState, "config" | "brokerAccounts">,
): PortfolioAccountStateResult {
  const instanceId = portfolio?.brokerInstanceId;
  const brokerInstance = useMemo(
    () => instanceId ? getBrokerInstance(state.config.brokerInstances, instanceId) : null,
    [instanceId, state.config.brokerInstances],
  );
  const { getBrokerAdapter } = usePluginBrokerActions();
  const broker = brokerInstance ? getBrokerAdapter(brokerInstance.brokerType) : null;
  const [liveStatus, setLiveStatus] = useState<BrokerConnectionStatus | null>(null);
  useEffect(() => {
    const readStatus = () => brokerInstance && broker?.getStatus ? broker.getStatus(brokerInstance) : null;
    setLiveStatus(readStatus());
    if (!brokerInstance || !broker?.subscribeStatus) return;
    return broker.subscribeStatus(brokerInstance, () => {
      setLiveStatus(readStatus());
    });
  }, [broker, brokerInstance]);
  const [liveAccounts, setLiveAccounts] = useState<BrokerAccount[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLiveAccounts([]);
    setAccountsError(null);
    if (!brokerInstance || !broker?.listAccounts || liveStatus?.state !== "connected") return;
    broker.listAccounts(brokerInstance)
      .then((accounts) => {
        if (!cancelled) setLiveAccounts(accounts);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLiveAccounts([]);
        setAccountsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [broker, brokerInstance, liveStatus?.state, liveStatus?.updatedAt]);
  const snapshot = useMemo(
    () => ({ status: liveStatus, accounts: liveAccounts }),
    [liveAccounts, liveStatus],
  );
  const accountState = useMemo(
    () => resolvePortfolioAccountState(portfolio, state, snapshot),
    [portfolio, snapshot, state.brokerAccounts, state.config],
  );
  return useMemo(() => ({ accountState, accountsError }), [accountState, accountsError]);
}

/** Rows the open drawer needs: its title, the numbers the header row had no room for, then currency balances. */
export function cashMarginDrawerHeight(accountState: ResolvedPortfolioAccountState, detailCount: number): number {
  return 1 + (detailCount > 0 ? 1 : 0) + Math.min(4, Math.max(1, accountState.visibleCashBalances.length));
}

/**
 * Opens from the `[c]ash` hint and takes no rows while closed. It continues
 * the header row rather than repeating it, so no number is shown twice.
 */
export function PortfolioCashMarginDrawer({
  accountState,
  detail,
  onToggle,
  width,
  height,
}: {
  accountState: ResolvedPortfolioAccountState;
  detail: PortfolioSummarySegment[];
  onToggle: () => void;
  width: number;
  height: number;
}) {
  const currencyRowsHeight = Math.max(1, height - 1 - (detail.length > 0 ? 1 : 0));
  return (
    <Box flexDirection="column" height={height}>
      <ActionRow label={t("Cash & Margin")} expanded width={width} onPress={onToggle} />
      {detail.length > 0 && (
        <Box height={1} overflow="hidden">
          {renderSummarySegments(detail, width)}
        </Box>
      )}
      <ScrollBox height={currencyRowsHeight} scrollY focusable={false}>
        {accountState.visibleCashBalances.length === 0 ? (
          <Text fg={colors.textDim}>{t("No non-zero cash balances.")}</Text>
        ) : (
          accountState.visibleCashBalances.map((balance) => (
            <Box key={balance.currency} height={1} flexDirection="row">
              <Text fg={colors.textBright}>{padTo(balance.currency, 4)}</Text>
              <Text fg={colors.textDim}>{" qty "}</Text>
              <Text fg={colors.text}>{padTo(formatMarketQuantity(balance.quantity, { isCashBalance: true, maxWidth: 14 }), 14, "right")}</Text>
              <Text fg={colors.textDim}>{"  value "}</Text>
              <Text fg={colors.text}>{padTo(balance.baseValue != null ? formatCompact(balance.baseValue) : "—", 10, "right")}</Text>
            </Box>
          ))
        )}
      </ScrollBox>
    </Box>
  );
}
