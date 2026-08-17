import { Box } from "../../../ui";
import { Button, EmptyState } from "../../../components";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";

/** Both scanners are Pro-only, so a refusal is a call to action, not an error. */
export function ScannerDeniedState({ reason }: { reason: string | null }) {
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <EmptyState
        title={reason === "pro_required"
          ? "Market scanners are part of Gloom Cloud Pro."
          : "Sign in to stream the market scanners."}
        message="One shared feed, streamed live to every Pro session."
      />
      <Box flexDirection="row" marginTop={1} gap={1}>
        <Button label="Upgrade to Pro" onPress={openUpgrade} />
        <Button label="Manage account" variant="secondary" onPress={openPlan} />
      </Box>
    </Box>
  );
}
