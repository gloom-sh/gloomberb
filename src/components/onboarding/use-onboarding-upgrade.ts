import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../../api-client";
import { type AppConfig, type OnboardingProgress, type OnboardingStage } from "../../types/config";
import { useAppActive } from "../../state/app/activity";
import { chatController } from "../../plugins/builtin/chat/controller";
import { type CloudBillingInterval } from "../../plugins/builtin/account-management/model";
import { loadUpgradeOffer, type UpgradeOffer } from "../../plugins/builtin/cloud/upgrade-dialog";
import { useCloudUpgradeAction } from "../../plugins/builtin/shared/cloud-upgrade";
import { usePlanAccess } from "../../api-client/plan-access";

export function useOnboardingUpgrade({
  stage, progress, saveProgressInBackground, persistProgress,
}: {
  stage: OnboardingStage;
  progress: OnboardingProgress;
  saveProgressInBackground: (patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">, baseConfig?: AppConfig | undefined) => void;
  persistProgress: (patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">, baseConfig?: AppConfig | undefined) => Promise<AppConfig>;
}) {
  const [offer, setOffer] = useState<UpgradeOffer | null>(null);
  const pricing = offer?.pricing ?? null;
  const [billingInterval, setBillingInterval] = useState<CloudBillingInterval>("month");

  const appActive = useAppActive();
  const planAccess = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction("onboarding-pro");
  // The price and whether this account still has its trial, asked again for
  // whichever account reaches the step.
  const accountId = planAccess.signedIn ? apiClient.getCurrentUser()?.id ?? null : null;
  useEffect(() => {
    if (stage !== "upgrade") return;
    let live = true;
    void loadUpgradeOffer().then((loaded) => {
      if (live) setOffer(loaded);
    });
    return () => {
      live = false;
    };
  }, [accountId, stage]);
  useEffect(() => {
    if (stage !== "upgrade" || !progress.checkoutOpenedAt || !appActive) return;
    void apiClient.getSession()
      .then(() => chatController.refreshSession())
      .catch(() => {});
  }, [appActive, progress.checkoutOpenedAt, stage]);

  useEffect(() => {
    if (stage === "upgrade" && planAccess.hasProAccess) {
      saveProgressInBackground({ stage: "ready", accountStatus: "signed-in" });
    }
  }, [planAccess.hasProAccess, saveProgressInBackground, stage]);

  const startUpgrade = useCallback(() => {
    void openUpgrade({
      interval: billingInterval,
      sheet: false,
      // Stamped once per checkout that opens, not per keypress: the repeats
      // of a held Enter are ignored.
      onOpening: () => {
        void persistProgress({
          stage: "upgrade",
          accountStatus: progress.accountStatus,
          checkoutOpenedAt: new Date().toISOString(),
        }).catch(() => {});
      },
    });
  }, [billingInterval, openUpgrade, persistProgress, progress.accountStatus]);

  const primaryUpgradeAction = useCallback(() => {
    if (planAccess.hasProAccess) {
      saveProgressInBackground({ stage: "ready", accountStatus: "signed-in" });
      return;
    }
    startUpgrade();
  }, [planAccess.hasProAccess, saveProgressInBackground, startUpgrade]);

  const continueFree = useCallback(() => {
    saveProgressInBackground({ stage: "ready", accountStatus: progress.accountStatus });
  }, [progress.accountStatus, saveProgressInBackground]);

  return {
    offer, pricing, billingInterval, setBillingInterval, planAccess, primaryUpgradeAction, continueFree,
  };
}
