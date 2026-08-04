import { apiClient } from "../../../api-client";
import type { GloomPluginContext } from "../../../types/plugin";
import { requestAccountManagementTab } from "../account-management/navigation";
import { openCloudUpgradeUrl } from "../shared/cloud-upgrade";
import { resolvePlanAccess } from "../shared/plan-access";

export function registerCloudUpgradeCommand(ctx: GloomPluginContext): void {
  ctx.registerCommand({
    id: "cloud-upgrade",
    label: "Upgrade to Pro",
    description: "Real-time market data, real-time news, and X data",
    keywords: ["upgrade", "pro", "pricing", "plan", "billing", "subscribe", "trial", "real-time"],
    category: "config",
    shortcut: "UPGRADE",
    // Paying subscribers have nothing to upgrade to; trial accounts still do.
    hidden: () => resolvePlanAccess(apiClient.getCurrentUser()).isPayingPro,
    execute: () => {
      if (!apiClient.getSessionToken()) {
        ctx.openCommandBar("Sign Up");
        return;
      }
      if (openCloudUpgradeUrl()) return;
      // No renderer-backed opener yet: fall back to the in-app billing surface.
      requestAccountManagementTab("pro");
      ctx.showPane("account-management");
    },
  });
}
