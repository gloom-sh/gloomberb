import { ActionRow } from "../../../components/ui/action-row";
import { Box, ScrollBox, Text } from "../../../ui";
import { t } from "../../../i18n";
import { colors } from "../../../theme/colors";
import { formatCompact, padTo } from "../../../utils/format";
import { formatMarketQuantity } from "../../../market-data/market/format";
import {
  renderSummarySegments,
  type PortfolioSummarySegment,
  type ResolvedPortfolioAccountState,
} from "./summary";

/**
 * Rows the open drawer needs: its title, the numbers the header row had no room
 * for, then every currency balance. The pane caps it; the drawer's own list only
 * scrolls by wheel, since the table keeps the paging keys.
 */
export function cashMarginDrawerHeight(accountState: ResolvedPortfolioAccountState, detailCount: number): number {
  return 1 + (detailCount > 0 ? 1 : 0) + Math.max(1, accountState.visibleCashBalances.length);
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
