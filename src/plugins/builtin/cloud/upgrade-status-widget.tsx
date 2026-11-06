import { useEffect, useState } from "react";
import { apiClient } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { Button } from "../../../components/ui/button";
import { DelayedMark, delayedMarkWidth, useStateQuoteDelay } from "../../../components/ui/delayed-mark";
import { Box, Text, useCommandBarShortcut, useUiCapabilities } from "../../../ui";
import { useViewport } from "../../../react/input";
import { useThemeColors } from "../../../theme/theme-context";
import { chatController, type ChatController } from "../chat/controller";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { CLOUD_QUOTE_DELAY_MINUTES, resolvePlanAccess } from "../../../api-client/plan-access";
import { useTrialOfferShowing } from "./trial-offer-status-widget";
import {
  NARROW_STATUS_BAR_COLUMNS,
  STATUS_WIDGET_COLUMNS,
  useOtherStatusWidgetClaims,
  useStatusWidgetClaim,
  useStatusWidgetRoom,
} from "../../../components/layout/status-widget-space";
import { displayWidth } from "../../../utils/format";

const CLAIM_ID = "cloud-upgrade";

interface CloudUpgradeStatusWidgetProps {
  controller?: Pick<ChatController, "getSnapshot" | "subscribe">;
}

/**
 * Global entitlement status: the trial countdown while Pro is on loan, or,
 * signed out or on the free plan, the one place that says the app's prices
 * are late (`◷ 15m delayed`), pressed for the upgrade. Said here, a price
 * outside a pane footer leaves its own mark out. While the trial offer line
 * already pitches Pro, the mark stands alone. Pro accounts have nothing to
 * report.
 */
export function CloudUpgradeStatusWidget({ controller = chatController }: CloudUpgradeStatusWidgetProps) {
  useAppLanguage();
  const colors = useThemeColors();
  const openUpgrade = useCloudUpgradeAction("status-widget");
  const openPlan = useCloudPlanAction();
  const offerShowing = useTrialOfferShowing();
  const { nativePaneChrome } = useUiCapabilities();
  // The status bar takes no keyboard focus; the chip names the command instead.
  const commandBarKey = useCommandBarShortcut();
  const [access, setAccess] = useState(() => resolvePlanAccess(apiClient.getCurrentUser()));
  const delayed = !access.isTrialActive && !access.hasProAccess;
  // The bar holds back its usual columns for the widgets' own text, which
  // this one shares with the account chip beside it: half of them are its
  // own. The note says "delayed" where the row has room for what it draws
  // past that half, and claims it, else it is the mark alone. The desktop
  // and the web say it on any bar wider than a phone's, the layout tabs
  // giving way; on a phone the word would cut the layout tab in front.
  const room = useStatusWidgetRoom();
  const { width: barColumns } = useViewport();
  const othersClaimed = useOtherStatusWidgetClaims(CLAIM_ID);
  const word = t("delayed");
  // The mark, the space before the word, the word and the space after the note.
  const noteColumns = delayedMarkWidth(CLOUD_QUOTE_DELAY_MINUTES, false) + 1 + displayWidth(word) + 1;
  const overflow = Math.max(0, noteColumns - STATUS_WIDGET_COLUMNS / 2);
  const spelled = !offerShowing && (nativePaneChrome
    ? barColumns >= NARROW_STATUS_BAR_COLUMNS
    : room - STATUS_WIDGET_COLUMNS - othersClaimed >= overflow);
  useStatusWidgetClaim(CLAIM_ID, delayed && spelled && !nativePaneChrome ? overflow : 0);
  useStateQuoteDelay(delayed);

  useEffect(
    // The chat widget already drives session refreshes; this only follows them.
    () => controller.subscribe(() => setAccess(resolvePlanAccess(apiClient.getCurrentUser()))),
    [controller],
  );

  if (access.isTrialActive) {
    return (
      <Button
        label={tf("Pro trial {days}d", { days: access.trialDaysLeft })}
        title={tf("Your plan ({key}, then {command})", { key: commandBarKey, command: "ACM" })}
        variant="plain"
        compact
        stopPropagation
        onPress={openPlan}
      />
    );
  }
  if (access.hasProAccess) return null;

  const mark = <DelayedMark minutes={CLOUD_QUOTE_DELAY_MINUTES} />;
  const detail = tf("{delay} delayed", { delay: `${CLOUD_QUOTE_DELAY_MINUTES}m` });
  return (
    <Box flexDirection="row" alignItems="center" flexShrink={0} paddingRight={1} data-gloom-role="delayed-status">
      {spelled ? (
        <Button
          label={detail}
          title={`${detail}. ${tf("Upgrade to Pro ({key}, then {command})", { key: commandBarKey, command: "UPGRADE" })}`}
          variant="plain"
          compact
          stopPropagation
          onPress={openUpgrade}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            {mark}
            <Text fg={colors.textDim} selectable={false}>{word}</Text>
          </Box>
        </Button>
      ) : mark}
    </Box>
  );
}
