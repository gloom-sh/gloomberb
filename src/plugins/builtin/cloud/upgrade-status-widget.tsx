import { useEffect, useState } from "react";
import { apiClient } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { Button } from "../../../components/ui/button";
import { DelayedMark } from "../../../components/ui/delayed-mark";
import { Box, useCommandBarShortcut } from "../../../ui";
import { chatController, type ChatController } from "../chat/controller";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { CLOUD_QUOTE_DELAY_MINUTES, resolvePlanAccess } from "../../../api-client/plan-access";
import { useTrialOfferShowing } from "./trial-offer-status-widget";

interface CloudUpgradeStatusWidgetProps {
  controller?: Pick<ChatController, "getSnapshot" | "subscribe">;
}

/**
 * Global entitlement status: the trial countdown while Pro is on loan, or,
 * signed out or on the free plan, the delayed mark the app's prices carry and
 * the upgrade. While the trial offer line already pitches Pro, the mark stands
 * alone. Pro accounts have nothing to report.
 */
export function CloudUpgradeStatusWidget({ controller = chatController }: CloudUpgradeStatusWidgetProps) {
  useAppLanguage();
  const openUpgrade = useCloudUpgradeAction("status-widget");
  const openPlan = useCloudPlanAction();
  const offerShowing = useTrialOfferShowing();
  // The status bar takes no keyboard focus; the chip names the command instead.
  const commandBarKey = useCommandBarShortcut();
  const [access, setAccess] = useState(() => resolvePlanAccess(apiClient.getCurrentUser()));

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
  return (
    <Box flexDirection="row" alignItems="center" gap={1} paddingRight={offerShowing ? 1 : 0} data-gloom-role="delayed-status">
      {mark}
      {offerShowing ? null : (
        <Button
          label={t("delayed data · upgrade")}
          title={tf("Upgrade to Pro ({key}, then {command})", { key: commandBarKey, command: "UPGRADE" })}
          variant="plain"
          compact
          stopPropagation
          onPress={openUpgrade}
        />
      )}
    </Box>
  );
}
