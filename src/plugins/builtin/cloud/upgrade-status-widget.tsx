import { useEffect, useState } from "react";
import { apiClient } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { Button } from "../../../components/ui/button";
import { DelayedMark, delayedMarkWidth } from "../../../components/ui/delayed-mark";
import { Box, useCommandBarShortcut, useUiCapabilities } from "../../../ui";
import { chatController, type ChatController } from "../chat/controller";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { CLOUD_QUOTE_DELAY_MINUTES, resolvePlanAccess } from "../../../api-client/plan-access";
import { useTrialOfferShowing } from "./trial-offer-status-widget";
import {
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
 * signed out or on the free plan, the delayed mark the app's prices carry and
 * the upgrade. While the trial offer line already pitches Pro, the mark stands
 * alone. Pro accounts have nothing to report.
 */
export function CloudUpgradeStatusWidget({ controller = chatController }: CloudUpgradeStatusWidgetProps) {
  useAppLanguage();
  const openUpgrade = useCloudUpgradeAction("status-widget");
  const openPlan = useCloudPlanAction();
  const offerShowing = useTrialOfferShowing();
  const { nativePaneChrome } = useUiCapabilities();
  // The status bar takes no keyboard focus; the chip names the command instead.
  const commandBarKey = useCommandBarShortcut();
  const [access, setAccess] = useState(() => resolvePlanAccess(apiClient.getCurrentUser()));
  // The bar holds back its usual columns for the widgets' own text, which
  // this one shares with the chat's sign-in: half of them are its own. The
  // label never shrinks into Feedback beside it: "delayed data · upgrade"
  // where the row has room for what the mark and "upgrade" draw past that
  // half and the words before it, else "upgrade". What it draws past the
  // usual columns is claimed, so the version chip gives way to it.
  const room = useStatusWidgetRoom();
  const othersClaimed = useOtherStatusWidgetClaims(CLAIM_ID);
  const free = !access.isTrialActive && !access.hasProAccess && !offerShowing;
  const longLabel = t("delayed data · upgrade");
  const shortLabel = t("upgrade");
  const overflow = Math.max(0, delayedMarkWidth(CLOUD_QUOTE_DELAY_MINUTES, false) + 1 + displayWidth(shortLabel) + 1
    - STATUS_WIDGET_COLUMNS / 2);
  const extra = displayWidth(longLabel) - displayWidth(shortLabel);
  const long = nativePaneChrome || room - STATUS_WIDGET_COLUMNS - othersClaimed >= overflow + extra;
  useStatusWidgetClaim(CLAIM_ID, free && !nativePaneChrome ? long ? extra : overflow : 0);

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
    <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0} paddingRight={offerShowing || !nativePaneChrome ? 1 : 0} data-gloom-role="delayed-status">
      {mark}
      {offerShowing ? null : (
        <Button
          label={long ? longLabel : shortLabel}
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
