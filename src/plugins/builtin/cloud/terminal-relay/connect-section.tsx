import { useCallback, useSyncExternalStore } from "react";
import { Button } from "../../../../components/ui/button";
import { t, tf } from "../../../../i18n";
import { useAppLanguage } from "../../../../i18n/react";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, Text } from "../../../../ui";
import { useDialogKeyboard } from "../../../../ui/dialog";
import { isPlainKey } from "../../../../utils/keyboard";
import { getSharedRegistry } from "../../../registry";
import { requestAccountManagementTab } from "../../account-management/navigation";
import type { McpConnectSectionProps } from "../mcp-connect/sections";
import { type AssistantGrant, terminalRelayGrants } from "./grants";

const NONE: AssistantGrant[] = [];

function allowedText(count: number): string {
  if (count === 0) return t("None allowed yet");
  return count === 1 ? t("1 assistant allowed") : tf("{count} assistants allowed", { count });
}

/**
 * The Terminal control line of the Connect an AI assistant dialog: what it
 * does, how many assistants may drive this terminal now, and the way to the
 * Agents tab where they are revoked. `m` or a click opens it.
 */
export function TerminalControlSection({ width, dialogId, dismiss }: McpConnectSectionProps) {
  useAppLanguage();
  const colors = useThemeColors();
  const grants = useSyncExternalStore(
    (listener) => terminalRelayGrants.subscribe(listener),
    () => terminalRelayGrants.list(),
    () => NONE,
  );
  const allowed = grants.filter((grant) => grant.decision !== "deny").length;
  const openAgents = useCallback(() => {
    requestAccountManagementTab("agents");
    getSharedRegistry()?.showPane("account-management");
    dismiss?.();
  }, [dismiss]);

  useDialogKeyboard((event) => {
    if (!isPlainKey(event, "m")) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    openAgents();
  }, { scope: dialogId });

  return (
    <Box flexDirection="column" width={width}>
      <Text fg={colors.textDim} wrapText>{t("With Terminal control, an assistant can drive this terminal.")}</Text>
      <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
        <Button label={t("Manage assistants")} shortcut="m" onPress={openAgents} />
        <Text fg={colors.textDim}>{allowedText(allowed)}</Text>
      </Box>
    </Box>
  );
}
