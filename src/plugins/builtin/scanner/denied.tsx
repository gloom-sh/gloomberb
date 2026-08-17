import { Box } from "../../../ui";
import { Button, EmptyState } from "../../../components";
import { t } from "../../../i18n";
import { CloudAuthNotice } from "../cloud/auth-actions";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";

/**
 * Options flow is the one scanner with no delayed tier to fall back to, so a
 * refusal is a call to action. Signed-out users need to sign in, not upgrade.
 */
export function ScannerDeniedState({ reason }: { reason: string | null }) {
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();

  if (reason === "auth_required") {
    return <CloudAuthNotice message={t("Sign in to stream the market scanners.")} />;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <EmptyState
        title="Options flow is part of Gloom Cloud Pro."
        message="Live sweeps, blocks, and large premium prints from the full OPRA feed."
      />
      <Box flexDirection="row" marginTop={1} gap={1}>
        <Button label={t("Upgrade to Pro")} onPress={openUpgrade} />
        <Button label={t("Manage account")} variant="secondary" onPress={openPlan} />
      </Box>
    </Box>
  );
}
