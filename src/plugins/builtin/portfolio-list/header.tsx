import { Box, ScrollBox, Text } from "../../../ui";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../../i18n";
import { TextAttributes } from "../../../ui";
import type { AppState } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { BrokerConnectionStatus } from "../../../types/broker";
import type { Portfolio } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { convertCurrency, formatCompact, padTo } from "../../../utils/format";
import { formatMarketQuantity } from "../../../market-data/market/format";
import { getBrokerInstance } from "../../../utils/broker-instances";
import { usePluginBrokerActions } from "../../runtime";
import {
  buildDrawerMetricSegments,
  renderSummarySegments,
  resolvePortfolioAccountState,
  type ResolvedPortfolioAccountState,
} from "./summary";

type CashDrawerPointerEvent = {
  preventDefault(): void;
  stopPropagation(): void;
};

export function shouldToggleCashMarginDrawer(key: string | undefined, showCashDrawer: boolean): boolean {
  return key === "c" && showCashDrawer;
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

export function PortfolioCashMarginDrawer({
  accountState,
  expanded,
  onToggle,
  width,
  height,
  baseCurrency,
  exchangeRates,
}: {
  accountState: ResolvedPortfolioAccountState;
  expanded: boolean;
  onToggle: () => void;
  width: number;
  height: number;
  baseCurrency: string;
  exchangeRates: Map<string, number>;
}) {
  const convertAccountValue = (value: number) => convertCurrency(
    value,
    accountState.account.currency || baseCurrency,
    baseCurrency,
    exchangeRates,
  );
  const previewText = `${accountState.visibleCashBalances.length} ccy · Cash ${formatCompact(convertAccountValue(accountState.account.totalCashValue ?? 0))} · ${accountState.sourceLabel}`;
  const drawerHeight = Math.max(1, height);

  if (!expanded) {
    return (
      <Box
        width={width}
        height={drawerHeight}
        flexDirection="row"
        backgroundColor={colors.bg}
        onMouseDown={(event: CashDrawerPointerEvent) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        onMouseUp={(event: CashDrawerPointerEvent) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{`▸ ${t("Cash & Margin")}`}</Text>
        <Box flexGrow={1} />
        <Text fg={colors.textDim}>{padTo(previewText, Math.max(0, width - 17), "right")}</Text>
      </Box>
    );
  }

  const metricSegments = buildDrawerMetricSegments(accountState.account, width, convertAccountValue);
  const currencyRowsHeight = Math.max(1, drawerHeight - 2);

  return (
    <Box flexDirection="column" height={drawerHeight}>
      <Box
        width={width}
        height={1}
        flexDirection="row"
        backgroundColor={colors.bg}
        onMouseDown={(event: CashDrawerPointerEvent) => {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
        onMouseUp={(event: CashDrawerPointerEvent) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{`▾ ${t("Cash & Margin")}`}</Text>
        <Box flexGrow={1} />
        <Text fg={colors.textDim}>{accountState.sourceLabel}</Text>
      </Box>
      <Box height={1} overflow="hidden">
        {renderSummarySegments(metricSegments, width)}
      </Box>
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
