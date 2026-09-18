import { useCallback, useEffect, useMemo } from "react";
import { apiClient } from "../../../api-client";
import { recordResearchActivity, researchUpgradeUrl } from "../../../api-client/research-activity";
import { getCurrentPluginTarget } from "../../current-target";
import type { PaneFooterSegment, PaneHint } from "../../../components";
import { tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useShortcut } from "../../../react/input";
import { useRendererHost } from "../../../ui";
import type { RendererHost } from "../../../ui";
import { getSharedRegistry } from "../../registry";
import { requestAccountManagementTab } from "../account-management/navigation";
import { resolvePlanAccess, usePlanAccess, type PlanAccess } from "./plan-access";

export const CLOUD_UPGRADE_URL = "https://gloom.sh/cloud?upgrade=pro";

/**
 * The renderer host only exists inside React, so UI that uses it publishes an
 * opener here for the command bar, which runs outside the tree.
 */
let cloudUpgradeOpener: (() => void) | null = null;

/**
 * Signed-out users get the public Cloud page. Signed-in free accounts go
 * straight to Stripe checkout, verified or not (the trial only activates once
 * the email is confirmed, which the status bar keeps asking for), and accounts
 * that already have Pro (paying or trialing) get the billing portal, so nobody
 * re-buys a subscription they already hold. Both URLs are account-bound, so no
 * session handoff is needed.
 */
export interface CloudUpgradeOptions {
  /** Billing interval for a fresh checkout; ignored when the account already has Pro. */
  interval?: "month" | "year";
}

export async function resolveCloudUpgradeUrl(options: CloudUpgradeOptions = {}): Promise<string> {
  recordResearchActivity("upgrade_intent");
  const returnTo = getCurrentPluginTarget() === "web" ? window.location.href : undefined;
  if (!apiClient.isSignedIn()) return researchUpgradeUrl(returnTo);
  const { url } = resolvePlanAccess(apiClient.getCurrentUser()).hasProAccess
    ? await apiClient.createBillingPortal()
    : await apiClient.createCloudCheckout(returnTo, options.interval ?? "month");
  return url;
}

/** Opens checkout or the billing portal in the user's browser. */
export async function openCloudUpgrade(
  rendererHost: Pick<RendererHost, "openExternal">,
  options: CloudUpgradeOptions = {},
): Promise<void> {
  await rendererHost.openExternal(await resolveCloudUpgradeUrl(options));
}

/** Opens the checkout page when any cloud UI has published an opener. */
export function openCloudUpgradeUrl(): boolean {
  if (!cloudUpgradeOpener) return false;
  cloudUpgradeOpener();
  return true;
}

function isCloudUpgradeOptions(value: unknown): value is CloudUpgradeOptions {
  return !!value && typeof value === "object" && "interval" in value;
}

/**
 * Opens the Pro checkout page in the user's browser. The action doubles as a
 * press handler for buttons and footer segments, which hand it their event,
 * so only an explicit options object changes the checkout.
 */
export function useCloudUpgradeAction(): (options?: unknown) => void {
  const rendererHost = useRendererHost();
  const openUpgrade = useCallback((options?: unknown) => {
    const checkout = isCloudUpgradeOptions(options) ? options : {};
    void openCloudUpgrade(rendererHost, checkout).catch(async () => {
      // Keep the Cloud page reachable when checkout cannot be created; a native
      // session still rides along on the server's one-time handoff URL.
      const url = await apiClient.createBrowserHandoff()
        .then((handoff) => handoff.url)
        .catch(() => CLOUD_UPGRADE_URL);
      void rendererHost.openExternal(url);
    });
  }, [rendererHost]);
  useEffect(() => {
    cloudUpgradeOpener = openUpgrade;
    return () => {
      if (cloudUpgradeOpener === openUpgrade) cloudUpgradeOpener = null;
    };
  }, [openUpgrade]);
  return openUpgrade;
}

/** Opens the account pane on its Pro tab, where plan and billing live. */
export function useCloudPlanAction(): () => void {
  return useCallback(() => {
    requestAccountManagementTab("pro");
    getSharedRegistry()?.showPane("account-management");
  }, []);
}

export interface CloudAccessFooterOptions {
  /** Compact delay the free tier gets on this pane's data, e.g. "15m" or "12h". */
  delayLabel: string;
  focused: boolean;
  /** Pane-unique shortcut scope. Omit to render the CTA without a `u` binding. */
  shortcutScope?: string;
  /** Set false while the pane happens to show data that is not cloud-delayed. */
  degraded?: boolean;
  segmentId?: string;
}

export interface CloudAccessFooter {
  access: PlanAccess;
  /** Null while the account already pays for Pro, or when nothing is degraded. */
  segment: PaneFooterSegment | null;
  /**
   * The call to action, for the pane to render beside its own shortcuts. Null
   * whenever no `u` is bound, which leaves the pitch inside `segment`.
   */
  hint: PaneHint | null;
  openUpgrade: () => void;
}

/**
 * One compact footer status for cloud data entitlements: the delay free accounts
 * get on this pane, or the remaining trial days while Pro is on loan. Panes keep
 * ownership of their own richer states (e.g. options stream coverage) and only
 * render this segment when it is non-null.
 */
export function useCloudAccessFooter({
  delayLabel,
  degraded = true,
  focused,
  segmentId = "cloud-access",
  shortcutScope,
}: CloudAccessFooterOptions): CloudAccessFooter {
  const language = useAppLanguage();
  const access = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();

  const showTrial = access.isTrialActive;
  const showUpgrade = !showTrial && !access.hasProAccess && degraded;
  const bindsShortcut = !!shortcutScope && showUpgrade && focused;

  useShortcut(
    (event) => {
      const key = (event.name ?? event.key ?? "").toLowerCase();
      if (!bindsShortcut || key !== "u") return;
      event.stopPropagation();
      event.preventDefault();
      openUpgrade();
    },
    { scope: shortcutScope ?? "cloud-access:upgrade", enabled: bindsShortcut },
  );

  const segment = useMemo<PaneFooterSegment | null>(() => {
    if (showTrial) {
      return {
        id: segmentId,
        onPress: openPlan,
        parts: [{
          text: tf("Pro trial · {days}d left", { days: access.trialDaysLeft }),
          tone: "positive",
        }],
      };
    }
    if (!showUpgrade) return null;
    return {
      id: segmentId,
      onPress: openUpgrade,
      parts: [{
        // With a `u` bound the pitch is the [u]pgrade hint, so the status says
        // only what is true of the data. Without one there is nowhere else for
        // it to go.
        text: shortcutScope
          ? tf("{delay} delayed", { delay: delayLabel })
          : tf("{delay} delayed · try Pro live", { delay: delayLabel }),
        tone: "warning",
      }],
    };
  }, [
    access.trialDaysLeft,
    delayLabel,
    language,
    openPlan,
    openUpgrade,
    segmentId,
    shortcutScope,
    showTrial,
    showUpgrade,
  ]);

  const hint = useMemo<PaneHint | null>(
    () => (shortcutScope && showUpgrade
      ? { id: `${segmentId}-upgrade`, key: "u", label: "pgrade", onPress: openUpgrade }
      : null),
    [openUpgrade, segmentId, shortcutScope, showUpgrade],
  );

  return { access, hint, openUpgrade, segment };
}
