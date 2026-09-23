import { Button } from "../../../components/ui/button";
import { DisclosureMarker } from "../../../components/ui/disclosure-marker";
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
  SUMMARY_DISCLOSURE_WIDTH,
  type PortfolioSummaryHeaderLayout,
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

/** Rows the header needs: the summary row, then the open drawer's leftover numbers and currency balances. */
export function portfolioSummaryHeaderHeight(
  layout: PortfolioSummaryHeaderLayout,
  accountState: ResolvedPortfolioAccountState | null,
  expanded: boolean,
): number {
  if (!accountState) return layout.row.length > 0 ? 1 : 0;
  if (!expanded) return 1;
  return 1 + (layout.detail.length > 0 ? 1 : 0) + Math.min(4, Math.max(1, accountState.visibleCashBalances.length));
}

/**
 * The headline numbers above the table. For a broker account the row is also
 * the Cash & Margin disclosure, and opening it adds what the row had no room
 * for plus the per-currency balances, so no number is shown twice.
 */
export function PortfolioSummaryHeader({
  layout,
  accountState,
  expanded,
  onToggle,
  width,
  height,
}: {
  layout: PortfolioSummaryHeaderLayout;
  /** Set when the row opens the account's cash and margin. */
  accountState: ResolvedPortfolioAccountState | null;
  expanded: boolean;
  onToggle: () => void;
  width: number;
  height: number;
}) {
  if (!accountState) {
    return <Box height={1} overflow="hidden">{renderSummarySegments(layout.row, width)}</Box>;
  }

  const rowWidth = Math.max(0, width - SUMMARY_DISCLOSURE_WIDTH);
  const summaryRow = (
    <Button label="Cash & Margin" variant="plain" compact flush stopPropagation expanded={expanded} onPress={onToggle} width={width}>
      <Box flexDirection="row" width="100%" alignItems="center" gap={1}>
        <DisclosureMarker expanded={expanded} color={colors.text} width={2} />
        {layout.row.length > 0
          ? renderSummarySegments(layout.row, rowWidth)
          : <Text fg={colors.text}>{t("Cash & Margin")}</Text>}
      </Box>
    </Button>
  );
  if (!expanded) return summaryRow;

  const currencyRowsHeight = Math.max(1, height - 1 - (layout.detail.length > 0 ? 1 : 0));
  return (
    <Box flexDirection="column" height={height}>
      {summaryRow}
      <Box flexDirection="column" paddingLeft={SUMMARY_DISCLOSURE_WIDTH}>
        {layout.detail.length > 0 && (
          <Box height={1} overflow="hidden">
            {renderSummarySegments(layout.detail, rowWidth)}
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
    </Box>
  );
}
