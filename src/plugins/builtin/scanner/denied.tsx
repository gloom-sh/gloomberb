import { Button, PaneStatusBody } from "../../../components";
import { t } from "../../../i18n";
import { SignInWall } from "../cloud/auth-actions";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";

/**
 * Options flow is the one scanner with no delayed tier to fall back to, so a
 * refusal is a call to action. Signed-out users need to sign in, not upgrade.
 */
export function ScannerDeniedState({ reason }: { reason: string | null }) {
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();

  if (reason === "auth_required") {
    return <SignInWall action="stream the market scanners" />;
  }

  // The status body carries the pane inset that a bare EmptyState lacks.
  return (
    <PaneStatusBody
      empty
      emptyTitle="Options flow is part of Gloom Cloud Pro."
      emptyMessage="Real-time sweeps, blocks and large premium prints across US options exchanges."
      actions={<>
        <Button label={t("Upgrade to Pro")} onPress={openUpgrade} />
        <Button label={t("Manage account")} variant="secondary" onPress={openPlan} />
      </>}
    />
  );
}
