import { Button } from "../../../../components/ui/button";
import { Box, Text } from "../../../../ui";
import { TextAttributes } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import type { BrokerAccount } from "../../../../types/trading";
import { formatCurrency } from "../../../../utils/format";
import { TradeBadge } from "../badge";
import {
  formatQuoteSummary,
  getTradeTonePalette,
  truncateTradeText as truncateText,
  type TradeTone,
} from "../utils";

function TradeSummaryPill({
  id,
  label,
  value,
  tone = "neutral",
  onPress,
}: {
  id: string;
  label: string;
  value: string;
  tone?: TradeTone;
  onPress?: () => void;
}) {
  const palette = getTradeTonePalette(tone);

  return (
    <Box
      key={id}
      height={1}
      flexDirection="row"
      backgroundColor={palette.background}
      paddingX={1}
      marginRight={1}
      onMouseDown={onPress}
    >
      <Text fg={tone === "neutral" ? colors.textDim : palette.text}>{label}</Text>
      <Text fg={palette.text} attributes={TextAttributes.BOLD}>{` ${value}`}</Text>
    </Box>
  );
}

export function TradeTabHeader({
  ticker,
  financials,
  profileLabel,
  isGatewayMode,
  connectionTone,
  currentAccountId,
  lockedBrokerInstanceId,
  hasAccount,
  activeAccount,
  interactive,
  nextStep,
  workflowTone,
  statusTone,
  statusText,
  busy,
  hasError,
  isSuccess,
  onEnterInteractive,
  onExitInteractive,
  onChooseBrokerInstance,
  onChooseAccount,
  onRefresh,
}: {
  ticker: TickerRecord;
  financials?: TickerFinancials | null;
  profileLabel?: string;
  isGatewayMode: boolean;
  connectionTone: TradeTone;
  currentAccountId?: string;
  lockedBrokerInstanceId?: string;
  hasAccount: boolean;
  activeAccount?: BrokerAccount;
  interactive: boolean;
  nextStep: string;
  workflowTone: TradeTone;
  statusTone: TradeTone;
  statusText: string;
  busy: boolean;
  hasError: boolean;
  isSuccess: boolean;
  onEnterInteractive: () => void;
  onExitInteractive: () => void;
  onChooseBrokerInstance: () => void;
  onChooseAccount: () => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between">
        <Box flexDirection="column" marginBottom={1}>
          <Box height={1} flexDirection="row">
            <Text attributes={TextAttributes.BOLD} fg={colors.textBright}>{`Trade ${ticker.metadata.ticker}`}</Text>
            {ticker.metadata.name && ticker.metadata.name !== ticker.metadata.ticker && (
              <Text fg={colors.textDim}>{` · ${ticker.metadata.name}`}</Text>
            )}
          </Box>
          <Box height={1}>
            <Text fg={colors.textMuted}>
              {formatQuoteSummary(financials?.quote, { assetCategory: ticker.metadata.assetCategory })}
            </Text>
          </Box>
        </Box>

        <Box flexDirection="row" flexWrap="wrap" justifyContent="flex-end">
          <TradeBadge
            label="Broker"
            value={profileLabel ? `${profileLabel} ${isGatewayMode ? "Gateway" : "Flex"}` : "Select profile"}
            tone={connectionTone}
            onPress={() => {
              onEnterInteractive();
              onChooseBrokerInstance();
            }}
          />
          <TradeBadge
            label="Account"
            value={currentAccountId || (lockedBrokerInstanceId ? "Locked" : "Select")}
            tone={hasAccount ? "accent" : "neutral"}
            onPress={() => {
              onEnterInteractive();
              onChooseAccount();
            }}
          />
          <TradeBadge
            label="Net Liq"
            value={activeAccount ? formatCurrency(activeAccount.netLiquidation || 0, activeAccount.currency || "USD") : "—"}
            tone="neutral"
            onPress={activeAccount ? undefined : () => {
              onEnterInteractive();
              onChooseAccount();
            }}
          />
        </Box>
      </Box>

      <Box flexDirection="row" flexWrap="wrap">
        <TradeSummaryPill id="next" label="Next" value={nextStep} tone={workflowTone} />
        <TradeSummaryPill
          id="ticket"
          label="Ticket"
          value={interactive ? "Captured" : "Standby"}
          tone={interactive ? "accent" : "neutral"}
          onPress={() => (interactive ? onExitInteractive() : onEnterInteractive())}
        />
        <Button
          label="Refresh"
          variant="ghost"
          disabled={busy}
          onPress={onRefresh}
        />
      </Box>

      <Box backgroundColor={getTradeTonePalette(statusTone).background} paddingX={1}>
        <Text fg={hasError ? colors.negative : isSuccess ? colors.positive : colors.text}>
          {truncateText(statusText, 160)}
        </Text>
      </Box>
    </>
  );
}
