/**
 * The web terminal's Pro trial offer, the `offer` arm of the
 * `web_terminal_trial_offer` experiment: one line in the status bar for
 * signed-out visitors on term.gloom.sh once the terminal has been on screen
 * for a little while. The web terminal never offers the trial on its own
 * otherwise, since onboarding is off there.
 *
 * The arm is asked for when the offer would show, in both arms, and that is
 * the exposure (`exposeWebExperiment`); the control shows nothing. The line
 * sits beside the signed-out Log in, where signed-in free accounts see
 * "delayed data · upgrade", and never covers the terminal. Like the other
 * status bar chips it takes no keyboard focus: its tooltip names UPGRADE, and
 * the Hide Pro Trial Offer command hides it. Hiding keeps it away for 14 days.
 * Where the status bar has no room for it, as on a phone, it never shows and
 * neither arm is counted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../../../api-client";
import { usePlanAccess } from "../../../api-client/plan-access";
import { exposeWebExperiment } from "../../../api-client/research-activity";
import { Button } from "../../../components/ui/button";
import { IconButton } from "../../../components/ui/icon";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import {
  STATUS_WIDGET_COLUMNS,
  useStatusWidgetClaim,
  useStatusWidgetRoom,
} from "../../../components/layout/status-widget-space";
import { displayWidth } from "../../../utils/format";
import { useAppVisible } from "../../../state/app/activity";
import { useThemeColors } from "../../../theme/theme-context";
import type { GloomPluginContext } from "../../../types/plugin";
import { Box, Span, Text, useCommandBarShortcut } from "../../../ui";
import { getCurrentPluginTarget } from "../../current-target";
import { usePluginState } from "../../runtime";
import { useCloudUpgradeAction } from "../shared/cloud-upgrade";

export const TRIAL_OFFER_EXPERIMENT = "web_terminal_trial_offer";
/**
 * On-screen time before the offer would show. Short enough that most
 * visitors reach it, which the test needs to read in weeks rather than months.
 */
const TRIAL_OFFER_DELAY_MS = 15_000;
const TRIAL_OFFER_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_TRIAL_DAYS = 7;
/** The hide button and the gap after the line. */
const OFFER_CHROME_COLUMNS = 4;
const DISMISS_COMMAND = "Hide Pro Trial Offer";
/** The offer's `upgrade_intent` placement. */
const TRIAL_OFFER_PLACEMENT = "web-terminal-offer";

/** Hides the offer that is showing; null while none is. For the command bar. */
let hideShowingOffer: (() => void) | null = null;

function isTrialOfferSnoozed(dismissedAt: number | null, now = Date.now()): boolean {
  return dismissedAt !== null && now - dismissedAt < TRIAL_OFFER_SNOOZE_MS;
}

interface TrialOfferCopy {
  lead: string;
  trial: string;
  columns: number;
}

function offerCopy(lead: string, trialDays: number): TrialOfferCopy {
  const trial = tf("{days} days free", { days: trialDays });
  return { lead, trial, columns: displayWidth(`${lead} · ${trial}`) + OFFER_CHROME_COLUMNS };
}

/**
 * What Pro adds and how long it is free, as long as the status bar has room
 * for beside its other widgets; null when not even the short line fits, as on
 * a phone, where the bar is full already.
 */
function trialOfferCopy(trialDays: number, widgetRoom: number): TrialOfferCopy | null {
  const spare = widgetRoom - STATUS_WIDGET_COLUMNS;
  const full = offerCopy(t("Real-time quotes and news with Pro"), trialDays);
  if (spare >= full.columns) return full;
  const short = offerCopy(t("Real-time data with Pro"), trialDays);
  return spare >= short.columns ? short : null;
}

interface TrialOfferStatusWidgetProps {
  /** Asks for the arm and counts the exposure; replaced in tests. */
  expose?: (experiment: string) => Promise<string | null>;
  delayMs?: number;
}

export function TrialOfferStatusWidget(props: TrialOfferStatusWidgetProps) {
  if (getCurrentPluginTarget() !== "web") return null;
  return <WebTrialOffer {...props} />;
}

type OfferState = "waiting" | "asking" | "shown" | "done";

function WebTrialOffer({ expose = exposeWebExperiment, delayMs = TRIAL_OFFER_DELAY_MS }: TrialOfferStatusWidgetProps) {
  useAppLanguage();
  const colors = useThemeColors();
  const access = usePlanAccess();
  const onScreen = useAppVisible();
  const widgetRoom = useStatusWidgetRoom();
  const openUpgrade = useCloudUpgradeAction(TRIAL_OFFER_PLACEMENT);
  // The status bar takes no keyboard focus; the line names the commands instead.
  const commandBarKey = useCommandBarShortcut();
  const [dismissedAt, setDismissedAt] = usePluginState<number | null>("trial-offer-dismissed-at", null);
  const [state, setState] = useState<OfferState>("waiting");
  const [trialDays, setTrialDays] = useState(DEFAULT_TRIAL_DAYS);
  const onScreenMs = useRef(0);
  const dismissedAtRef = useRef(dismissedAt);
  dismissedAtRef.current = dismissedAt;
  const signedOut = !access.signedIn;
  const copy = trialOfferCopy(trialDays, widgetRoom);
  // Where the line cannot fit it could not show, so neither arm is asked.
  const fits = trialOfferCopy(DEFAULT_TRIAL_DAYS, widgetRoom) !== null;

  // Counts only the time the terminal is on screen with room for the line, so
  // a tab opened in the background does not show the offer the moment someone
  // switches to it.
  useEffect(() => {
    if (state !== "waiting" || !signedOut || !onScreen || !fits) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      setState("asking");
      void expose(TRIAL_OFFER_EXPERIMENT).then(async (variant) => {
        if (variant !== "offer" || isTrialOfferSnoozed(dismissedAtRef.current) || apiClient.isSignedIn()) {
          setState("done");
          return;
        }
        const pricing = await apiClient.getCloudPricing().catch(() => null);
        if (pricing && pricing.trialDays > 0) setTrialDays(pricing.trialDays);
        setState("shown");
      });
    }, Math.max(0, delayMs - onScreenMs.current));
    return () => {
      clearTimeout(timer);
      onScreenMs.current += Date.now() - startedAt;
    };
  }, [delayMs, expose, fits, onScreen, signedOut, state]);

  const showing = state === "shown" && signedOut && !isTrialOfferSnoozed(dismissedAt) && copy !== null;
  // The version chip and the desktop link give way to the line.
  useStatusWidgetClaim("trial-offer", showing && copy ? copy.columns : 0);
  const hide = useCallback(() => {
    setDismissedAt(Date.now());
    setState("done");
  }, [setDismissedAt]);

  useEffect(() => {
    if (!showing) return;
    hideShowingOffer = hide;
    return () => {
      if (hideShowingOffer === hide) hideShowingOffer = null;
    };
  }, [hide, showing]);

  if (!showing || !copy) return null;

  const label = `${copy.lead} · ${copy.trial}`;
  return (
    <Box flexDirection="row" alignItems="center" paddingRight={1} data-gloom-role="trial-offer">
      <Button
        label={label}
        title={tf("Try Pro free for {days} days ({key}, then {command})", {
          days: trialDays,
          key: commandBarKey,
          command: "UPGRADE",
        })}
        variant="plain"
        compact
        stopPropagation
        onPress={() => openUpgrade()}
      >
        <Text fg={colors.text}>
          {`${copy.lead} · `}
          <Span fg={colors.positive}>{copy.trial}</Span>
        </Text>
      </Button>
      <IconButton
        icon="close"
        label={t("Hide the Pro offer")}
        title={tf("Hide for 14 days ({key}, then {command})", { key: commandBarKey, command: DISMISS_COMMAND })}
        onPress={hide}
      />
    </Box>
  );
}

/** The keyboard way to hide the offer, listed only while it shows. */
export function registerTrialOfferCommand(ctx: GloomPluginContext): void {
  ctx.registerCommand({
    id: "cloud-hide-trial-offer",
    label: DISMISS_COMMAND,
    description: "Hide the Pro trial offer in the status bar for 14 days",
    keywords: ["hide", "dismiss", "offer", "trial", "pro"],
    category: "config",
    hidden: () => !hideShowingOffer,
    execute: () => {
      hideShowingOffer?.();
    },
  });
}
