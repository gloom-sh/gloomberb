import { useEffect, useState } from "react";
import { apiClient } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useAppSelector } from "../../../state/app/context";
import { Button } from "../../../components/ui/button";
import { chatController, type ChatController } from "../chat/controller";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { resolvePlanAccess } from "../shared/plan-access";

interface CloudUpgradeStatusWidgetProps {
  controller?: Pick<ChatController, "getSnapshot" | "subscribe">;
}

/**
 * Global entitlement status: the trial countdown while Pro is on loan, or the
 * delay free accounts get on cloud data. Signed-out users already have sign-in
 * affordances next to it, and paying subscribers have nothing to report.
 */
export function CloudUpgradeStatusWidget({ controller = chatController }: CloudUpgradeStatusWidgetProps) {
  useAppLanguage();
  const cloudPluginDisabled = useAppSelector((state) => state.config.disabledPlugins).includes("gloomberb-cloud");
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();
  const [access, setAccess] = useState(() => resolvePlanAccess(apiClient.getCurrentUser()));

  useEffect(
    // The chat widget already drives session refreshes; this only follows them.
    () => controller.subscribe(() => setAccess(resolvePlanAccess(apiClient.getCurrentUser()))),
    [controller],
  );

  if (cloudPluginDisabled || !access.signedIn || access.isPayingPro) return null;

  const trial = access.isTrialActive;
  const label = trial
    ? tf("Pro trial {days}d", { days: access.trialDaysLeft })
    : t("delayed data · upgrade");

  return <Button label={label} variant="ghost" compact stopPropagation onPress={trial ? openPlan : openUpgrade} />;
}
