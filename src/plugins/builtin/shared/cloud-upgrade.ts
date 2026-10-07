import { useCallback, useEffect, useMemo, useRef } from "react";
import { apiClient } from "../../../api-client";
import { recordResearchActivity, researchUpgradeUrl } from "../../../api-client/research-activity";
import { getCurrentPluginTarget } from "../../current-target";
import type { PaneFooterSegment, PaneHint } from "../../../components";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useRendererHost } from "../../../ui";
import type { RendererHost } from "../../../ui";
import { getSharedRegistry } from "../../registry";
import { requestAccountManagementTab } from "../account-management/navigation";
import { resolvePlanAccess, usePlanAccess, type PlanAccess } from "../../../api-client/plan-access";
import { useViewport } from "../../../react/input";
import { useOptionalDialog } from "../../../ui/dialog";
import { promptCloudUpgrade } from "../cloud/upgrade-dialog";

const CLOUD_UPGRADE_URL = "https://gloom.sh/cloud?upgrade=pro";

/**
 * The renderer host only exists inside React, so UI that uses it publishes an
 * opener here for the command bar, which runs outside the tree. Every mounted
 * prompt publishes one, so a pane closing never leaves the command without.
 */
const cloudUpgradeOpeners = new Set<(options?: unknown) => void>();

/**
 * Signed-out users get the public Cloud page. Signed-in free accounts go
 * straight to Stripe checkout, verified or not (the trial only activates once
 * the email is confirmed, which the status bar keeps asking for), and accounts
 * that already have Pro (paying or trialing) get the billing portal, so nobody
 * re-buys a subscription they already hold. Both URLs are account-bound, so no
 * session handoff is needed.
 */
interface CloudUpgradeOptions {
  /**
   * The prompt the upgrade came from, sent with `upgrade_intent` so each one's
   * conversion can be read: a short id in the shape of a tab id (`srch-wall`,
   * `status-widget`), never the prompt's text or anything the user typed.
   */
  placement?: string;
  /** Billing interval for a fresh checkout; ignored when the account already has Pro. */
  interval?: "month" | "year";
  /** False when the upgrade sheet already recorded the intent on open. */
  recordIntent?: boolean;
  /** False when the caller already made the pitch, like onboarding's Pro step. */
  sheet?: boolean;
  /**
   * Called once checkout or the billing portal starts opening, after the sheet;
   * never for a press ignored as a repeat.
   */
  onOpening?: () => void;
}

function recordUpgradeIntent(placement: string | undefined): void {
  recordResearchActivity("upgrade_intent", undefined, undefined, { placement });
}

/**
 * The page an upgrade opens: Stripe checkout for a free account, the billing
 * portal for one that has Pro, and the public Cloud page when signed out or
 * when neither can be created.
 */
type CloudUpgradePage = "checkout" | "portal" | "cloud";

/** How long another open of the same page is ignored once one has opened. */
const CLOUD_UPGRADE_REOPEN_MS = 3_000;

/**
 * How long a page may stay opening before another press tries again. The
 * checkout and portal requests have no deadline of their own, and one that
 * hangs must not block the page until the app restarts.
 */
const CLOUD_UPGRADE_PENDING_MS = 30_000;

/**
 * When each page may open again: not while its URL is being created or
 * opened (up to {@link CLOUD_UPGRADE_PENDING_MS}), and not for
 * {@link CLOUD_UPGRADE_REOPEN_MS} after it opened. Every
 * open creates a Stripe session and a browser tab, and a held Enter repeats a
 * press many times a second. Keyed by page, so a checkout that just opened
 * never swallows the billing portal or the Cloud page.
 */
const cloudUpgradeBlockedUntil = new Map<CloudUpgradePage, number>();

function currentCloudUpgradePage(): CloudUpgradePage {
  if (!apiClient.isSignedIn()) return "cloud";
  return resolvePlanAccess(apiClient.getCurrentUser()).hasProAccess ? "portal" : "checkout";
}

function isCloudUpgradeBlocked(page: CloudUpgradePage): boolean {
  return (cloudUpgradeBlockedUntil.get(page) ?? 0) > Date.now();
}

/**
 * Runs `open` unless `page` is already opening or opened moments ago. A failed
 * open releases the page at once, so a retry works, and rethrows. A call that
 * outlived its pending window leaves the block of the call after it alone.
 */
async function openCloudUpgradePage(page: CloudUpgradePage, open: () => Promise<void>): Promise<void> {
  if (isCloudUpgradeBlocked(page)) return;
  const pending = Date.now() + CLOUD_UPGRADE_PENDING_MS;
  cloudUpgradeBlockedUntil.set(page, pending);
  const settle = (until: number | null) => {
    if (cloudUpgradeBlockedUntil.get(page) !== pending) return;
    if (until === null) cloudUpgradeBlockedUntil.delete(page);
    else cloudUpgradeBlockedUntil.set(page, until);
  };
  try {
    await open();
  } catch (error) {
    settle(null);
    throw error;
  }
  settle(Date.now() + CLOUD_UPGRADE_REOPEN_MS);
}

/** Forgets every recent open, so one test's checkout does not swallow the next test's. */
export function resetCloudUpgradeGuardForTests(): void {
  cloudUpgradeBlockedUntil.clear();
}

async function resolveCloudUpgradeUrl(page: CloudUpgradePage, options: CloudUpgradeOptions): Promise<string> {
  const returnTo = getCurrentPluginTarget() === "web" ? window.location.href : undefined;
  if (page === "cloud") return researchUpgradeUrl(returnTo);
  const { url } = page === "portal"
    ? await apiClient.createBillingPortal()
    : await apiClient.createCloudCheckout(returnTo, options.interval ?? "month");
  return url;
}

/** Opens checkout, the billing portal or the Cloud page in the user's browser. */
async function openCloudUpgrade(
  rendererHost: Pick<RendererHost, "openExternal">,
  page: CloudUpgradePage,
  options: CloudUpgradeOptions,
): Promise<void> {
  await rendererHost.openExternal(await resolveCloudUpgradeUrl(page, options));
}

/**
 * Opens the checkout page when any cloud UI has published an opener, counted
 * under `placement` rather than the UI that published it.
 */
export function openCloudUpgradeUrl(placement: string): boolean {
  const opener = [...cloudUpgradeOpeners].at(-1);
  if (!opener) return false;
  opener({ placement });
  return true;
}

const CLOUD_UPGRADE_OPTION_KEYS: ReadonlyArray<keyof CloudUpgradeOptions> = ["placement", "interval", "recordIntent", "sheet", "onOpening"];

/** A press event carries none of these keys, so it never reads as options. */
function isCloudUpgradeOptions(value: unknown): value is CloudUpgradeOptions {
  return !!value && typeof value === "object" && CLOUD_UPGRADE_OPTION_KEYS.some((key) => key in value);
}

/**
 * Opens the Pro checkout page in the user's browser, counting the intent under
 * `placement` (see {@link CloudUpgradeOptions.placement}). The action doubles
 * as a press handler for buttons and footer segments, which hand it their
 * event, so only an explicit options object changes the checkout. It settles
 * once checkout has opened or the person backed out of the sheet. A call while
 * the same page is opening, or for a few seconds after it opened, is ignored:
 * a held Enter would otherwise open a checkout per keypress.
 *
 * A signed-in account without Pro sees the upgrade sheet first (what Pro adds,
 * what today costs), and checkout opens only once they choose to go on.
 * Signed-out users get the public Cloud page and Pro accounts the billing
 * portal, as before.
 */
export function useCloudUpgradeAction(placement: string): (options?: unknown) => Promise<void> {
  const rendererHost = useRendererHost();
  // Null in isolated renders (tests, previews): checkout then opens directly.
  const dialog = useOptionalDialog();
  const viewport = useViewport();
  const viewportWidthRef = useRef(viewport.width);
  viewportWidthRef.current = viewport.width;
  const openUpgrade = useCallback(async (options?: unknown) => {
    const checkout: CloudUpgradeOptions = { placement, ...(isCloudUpgradeOptions(options) ? options : {}) };
    const openCheckout = async (resolved: CloudUpgradeOptions) => {
      if (resolved.recordIntent !== false) recordUpgradeIntent(resolved.placement);
      const page = currentCloudUpgradePage();
      await openCloudUpgradePage(page, async () => {
        resolved.onOpening?.();
        await openCloudUpgrade(rendererHost, page, resolved);
      }).catch(() => (
        // Keep the Cloud page reachable when checkout cannot be created; a native
        // session still rides along on the server's one-time handoff URL. Under
        // the Cloud page's guard, so a retry that fails again moments later
        // opens no second tab.
        openCloudUpgradePage("cloud", async () => {
          const url = await apiClient.createBrowserHandoff()
            .then((handoff) => handoff.url)
            .catch(() => CLOUD_UPGRADE_URL);
          await rendererHost.openExternal(url);
        })
      )).catch(() => {});
    };
    if (
      checkout.sheet === false ||
      !dialog ||
      !apiClient.isSignedIn() ||
      resolvePlanAccess(apiClient.getCurrentUser()).hasProAccess
    ) {
      await openCheckout(checkout);
      return;
    }
    recordUpgradeIntent(checkout.placement);
    // Checkout is opening or just opened: a second sheet would lead nowhere.
    if (isCloudUpgradeBlocked("checkout")) return;
    const interval = await promptCloudUpgrade(dialog, {
      interval: checkout.interval,
      viewportWidth: viewportWidthRef.current,
    });
    if (interval) await openCheckout({ ...checkout, interval, recordIntent: false });
  }, [dialog, placement, rendererHost]);
  useEffect(() => {
    cloudUpgradeOpeners.add(openUpgrade);
    return () => {
      cloudUpgradeOpeners.delete(openUpgrade);
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

/**
 * The key for the Pro call to action. Not `u`: that is the app's install-update
 * key, and one press must not both update and open checkout.
 */
export const CLOUD_PLAN_KEY = "$";

export interface CloudAccessFooterOptions {
  /** Compact delay the free tier gets on this pane's data, e.g. "15m" or "12h". */
  delayLabel: string;
  focused: boolean;
  /**
   * Set when the pane renders the returned `hint`: the call to action then
   * takes the {@link CLOUD_PLAN_KEY} key, which the pane footer binds. Omit to
   * keep the pitch inside `segment` with no key.
   */
  shortcutScope?: string;
  /** Set false while the pane happens to show data that is not cloud-delayed. */
  degraded?: boolean;
  segmentId?: string;
  /** The upgrade intent's placement id (see {@link CloudUpgradeOptions.placement}); the segment id when omitted. */
  placement?: string;
}

export interface CloudAccessFooter {
  access: PlanAccess;
  /** Null while the account already pays for Pro, or when nothing is degraded. */
  segment: PaneFooterSegment | null;
  /**
   * The call to action, for the pane to render beside its own shortcuts. Null
   * without a `shortcutScope`, which leaves the pitch inside `segment`.
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
  segmentId = "cloud-access",
  shortcutScope,
  placement = segmentId,
}: CloudAccessFooterOptions): CloudAccessFooter {
  const language = useAppLanguage();
  const access = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction(placement);
  const openPlan = useCloudPlanAction();

  const showTrial = access.isTrialActive;
  const showUpgrade = !showTrial && !access.hasProAccess && degraded;

  const segment = useMemo<PaneFooterSegment | null>(() => {
    if (showTrial) {
      const label = t("Manage Pro plan");
      return {
        id: segmentId,
        onPress: openPlan,
        // The footer binds the key, and the pane menu lists the segment by its label.
        ...(shortcutScope ? { shortcut: CLOUD_PLAN_KEY, label, title: `${label} (${CLOUD_PLAN_KEY})` } : {}),
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
        // With a key the pitch is the upgrade hint, so the status says only
        // what is true of the data. Without one there is nowhere else for it
        // to go.
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
      ? { id: `${segmentId}-upgrade`, key: CLOUD_PLAN_KEY, label: t("upgrade"), title: t("Upgrade to Pro"), onPress: openUpgrade }
      : null),
    [language, openUpgrade, segmentId, shortcutScope, showUpgrade],
  );

  return { access, hint, openUpgrade, segment };
}
