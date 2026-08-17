import { Box, Text, useUiHost } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import type { ListViewItem } from "../../ui";
import { getBrokerLabel } from "./utils";

export function BrokerSyncPanel({
  choices,
  selectedBrokerId,
  brokerSyncing,
  brokerSyncError,
}: {
  choices: ListViewItem[];
  selectedBrokerId: string;
  brokerSyncing: boolean;
  brokerSyncError: string | null;
}) {
  const brokerLabel = getBrokerLabel(choices, selectedBrokerId);
  const desktop = useUiHost().kind === "desktop-web";

  return (
    <Box flexDirection="column" paddingX={desktop ? 0 : 2} style={desktop ? { marginTop: 14 } : undefined}>
      <Box height={desktop ? 1 : 2} overflow="hidden">
        <Text fg={brokerSyncing ? colors.text : colors.negative} wrapText={!desktop}>
          {brokerSyncing
            ? tf("Connecting to {broker} and importing accounts and positions...", { broker: brokerLabel })
            : brokerSyncError || tf("Unable to sync {broker}.", { broker: brokerLabel })}
        </Text>
      </Box>
      <Box height={1} />
      <Box height={desktop ? 1 : 2} overflow="hidden">
        <Text fg={colors.textDim} wrapText={!desktop}>
          {brokerSyncing
            ? t("This happens now so your portfolio is ready before onboarding finishes.")
            : t("Press Enter to retry, or Backspace to edit the broker settings.")}
        </Text>
      </Box>
    </Box>
  );
}
