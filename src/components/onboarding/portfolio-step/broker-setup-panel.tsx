import { Box, Span, Strong, Text, Underline, useUiHost } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import { ExternalLink, type ListViewItem } from "../../ui";
import { getBrokerLabel } from "./utils";

/** Opens the setup link below the steps; the wizard binds it. */
export const BROKER_GUIDE_KEY = "o";

const IBKR_FLEX_GUIDE_URL = "https://www.ibkrguides.com/orgportal/performanceandstatements/flex.htm";
const IBKR_GATEWAY_DOWNLOAD_URL = "https://www.interactivebrokers.com/en/trading/ibgateway-stable.php";

/** The link the setup step shows for this broker and connection mode, if any. */
export function brokerSetupGuideUrl(
  brokerId: string,
  brokerValues: Record<string, Record<string, string>>,
): string | null {
  if (brokerId !== "ibkr") return null;
  return brokerValues[brokerId]?.connectionMode === "gateway" ? IBKR_GATEWAY_DOWNLOAD_URL : IBKR_FLEX_GUIDE_URL;
}

/** The link with its key after it, the way a button shows its shortcut. */
function GuideLink({ url }: { url: string }) {
  return (
    <Box flexDirection="row" minWidth={0}>
      <Box flexShrink={1} minWidth={0} overflow="hidden">
        <ExternalLink url={url} />
      </Box>
      <Box flexShrink={0} height={1}>
        <Text fg={colors.textMuted}>{` ${BROKER_GUIDE_KEY}`}</Text>
      </Box>
    </Box>
  );
}

export function BrokerSetupPanel({
  choices,
  selectedBrokerId,
  brokerValues,
}: {
  choices: ListViewItem[];
  selectedBrokerId: string;
  brokerValues: Record<string, Record<string, string>>;
}) {
  const brokerLabel = getBrokerLabel(choices, selectedBrokerId);
  const connectionMode = brokerValues[selectedBrokerId]?.connectionMode;
  const isGateway = connectionMode === "gateway";
  const desktop = useUiHost().kind === "desktop-web";

  return (
    <Box flexDirection="column" paddingX={desktop ? 0 : 2} style={desktop ? { marginTop: 14 } : undefined}>
      {selectedBrokerId === "ibkr" && !isGateway && (
        <>
          <Box height={1} overflow="hidden">
            <Text fg={colors.textDim}>{t("You'll need these details from IBKR Account Management:")}</Text>
          </Box>
          <Box height={desktop ? 2 : 1} />
          <Box height={1}>
            <Text fg={colors.textDim}>{t("1. Go to ")}<Underline><Span fg={colors.text}>{t("Reports > Flex Queries")}</Span></Underline></Text>
          </Box>
          <Box height={1} overflow="hidden">
            <Text fg={colors.textDim}>{t("2. Create a Flex Query that includes positions data")}</Text>
          </Box>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("3. Note the ")}<Strong><Span fg={colors.text}>{t("Query ID")}</Span></Strong>{t(" (numeric)")}</Text>
          </Box>
          <Box height={desktop ? 1 : 2} overflow="hidden">
            <Text fg={colors.textDim}>{t("4. Under ")}<Underline><Span fg={colors.text}>{t("Reports > Settings")}</Span></Underline>{t(", generate a ")}<Strong><Span fg={colors.text}>{t("Flex Web Service Token")}</Span></Strong></Text>
          </Box>
          <Box height={desktop ? 2 : 1} />
          <GuideLink url={IBKR_FLEX_GUIDE_URL} />
        </>
      )}

      {selectedBrokerId === "ibkr" && isGateway && (
        <>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("You'll need IB Gateway or TWS running locally:")}</Text>
          </Box>
          <Box height={desktop ? 2 : 1} />
          <Box height={1}>
            <Text fg={colors.textDim}>{t("1. Download and install ")}<Strong><Span fg={colors.text}>{t("IB Gateway")}</Span></Strong>{t(" (or use TWS)")}</Text>
          </Box>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("2. Log in with your IBKR credentials")}</Text>
          </Box>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("3. In ")}<Underline><Span fg={colors.text}>{t("Configuration > API > Settings")}</Span></Underline>{":"}</Text>
          </Box>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("   Enable \"ActiveX and Socket Clients\"")}</Text>
          </Box>
          <Box height={desktop ? 1 : 2} overflow="hidden">
            <Text fg={colors.textDim}>{t("   Gloomberb can auto-detect local API ports (4001, 4002, 7496, 7497)")}</Text>
          </Box>
          <Box height={desktop ? 1 : 2} overflow="hidden">
            <Text fg={colors.textDim}>{t("   Use Manual setup only if you need a custom host or exact socket port")}</Text>
          </Box>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("4. Keep it running while using Gloomberb")}</Text>
          </Box>
          <Box height={desktop ? 2 : 1} />
          <GuideLink url={IBKR_GATEWAY_DOWNLOAD_URL} />
        </>
      )}

      {selectedBrokerId !== "ibkr" && (
        <>
          <Box height={1}>
            <Text fg={colors.textDim}>{tf("You'll need your {broker} API credentials.", { broker: brokerLabel })}</Text>
          </Box>
          <Box height={1}>
            <Text fg={colors.textDim}>{t("Check your broker's documentation for setup instructions.")}</Text>
          </Box>
        </>
      )}

      <Box height={desktop ? 2 : 1} />
    </Box>
  );
}
