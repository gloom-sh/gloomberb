/**
 * The Pro pitch between an upgrade button and Stripe. Signed-in free accounts
 * used to land straight on a card form with nothing on it but a price; this
 * says what Pro adds, what today costs and when the first charge lands, and
 * only then opens checkout. Signed out, it is what an upgrade button opens
 * first: what Pro adds and what it costs, before any account is asked for.
 */
import { logFailure } from "../utils/log-failure";
import { useCallback, useEffect, useState } from "react";
import { apiClient, type CloudAccountPlan, type CloudPricing } from "../api-client";
import { Button } from "../components/ui/button";
import { DialogActions } from "../components/ui/dialog-actions";
import { KeyValueRow } from "../components/ui/display";
import { DialogFrame } from "../components/ui/frame";
import { SegmentedControl } from "../components/ui/toggle";
import { t, tf } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { useThemeColors } from "../theme/theme-context";
import { Box, Text } from "../ui";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../ui/dialog";
import { displayWidth } from "../utils/format";
import { isPlainKey } from "../utils/keyboard";
import {
  type CloudBillingInterval,
  formatCloudPrice,
  formatTrialEnd,
  monthsFreeYearly,
  trialDaysOf,
} from "./billing";

const CONTENT_WIDTH = 64;
/** The signed-out sheet's key for an account without Pro, shown on its button. */
const SIGN_UP_FREE_KEY = "f";
/** Border plus padding the terminal dialog host draws around the content. */
const TERMINAL_DIALOG_CHROME = 6;
const FEATURE_LABEL_WIDTH = 16;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What the account can buy right now. Null fields mean the server could not say. */
export interface UpgradeOffer {
  pricing: CloudPricing | null;
  trialAvailable: boolean | null;
  paymentFailed: boolean;
}

export interface UpgradeDialogCopy {
  title: string;
  subtitle: string;
  confirmLabel: string;
  /** The interval toggle and the feature list; hidden while fixing a failed payment. */
  showPlan: boolean;
}

/**
 * The words on the sheet for each state. "$0 today" is only ever said when the
 * server confirmed this account still has its trial: an account that used it
 * is billed on the spot, and one we could not check might be. Signed out there
 * is no account to check, so the sheet says what holds for a new one, and the
 * account that then signs in reads its own terms before any checkout opens.
 */
export function upgradeDialogCopy(
  offer: UpgradeOffer | null,
  interval: CloudBillingInterval,
  now: Date,
  signedOut = false,
): UpgradeDialogCopy {
  // What Pro gets them, not the plan's name: the same title while it loads, with
  // or without a trial, so only the terms under it change.
  const title = t("One better trade pays for Pro");
  if (!offer) {
    return { title, subtitle: t("Loading…"), confirmLabel: t("Start free trial"), showPlan: true };
  }
  if (offer.paymentFailed) {
    return {
      title: t("Your last payment didn't go through"),
      subtitle: t("Pro is paused until your open invoice is paid. Pay it with another card and real-time data comes straight back."),
      confirmLabel: t("Pay with another card"),
      showPlan: false,
    };
  }
  const price = formatCloudPrice(offer.pricing, interval);
  if (signedOut && trialDaysOf(offer.pricing) > 0) {
    return {
      title,
      subtitle: tf("New accounts get Pro free for {days} days, then {price}. Card required. Cancel before and you pay nothing.", {
        days: trialDaysOf(offer.pricing),
        price,
      }),
      confirmLabel: t("Start free trial"),
      showPlan: true,
    };
  }
  if (offer.trialAvailable === true) {
    const days = trialDaysOf(offer.pricing);
    const firstCharge = formatTrialEnd(new Date(now.getTime() + days * MS_PER_DAY));
    return {
      title,
      subtitle: tf("Pro is free for {days} days. $0 today, then {price} from {date}. Card required. Cancel before and you pay nothing.", {
        days,
        price,
        date: firstCharge ?? "",
      }),
      confirmLabel: t("Start free trial"),
      showPlan: true,
    };
  }
  return {
    title,
    subtitle: offer.trialAvailable === false
      ? tf("{price}, billed today. Cancel anytime.", { price })
      : tf("{price}. Cancel anytime.", { price }),
    confirmLabel: t("Continue to checkout"),
    showPlan: true,
  };
}

export interface ProStepCopy {
  confirmLabel: string;
  /** The line under the price. */
  note: string;
}

/**
 * Onboarding's Pro step makes the pitch itself and opens checkout without the
 * sheet, so it keeps the sheet's rule: the free trial and "$0 today" only when
 * the server confirmed this account still has its trial.
 */
export function proStepCopy(offer: UpgradeOffer | null): ProStepCopy {
  if (offer?.trialAvailable === true) {
    const days = trialDaysOf(offer.pricing);
    return {
      confirmLabel: tf("Start {days}-day free trial", { days }),
      note: tf("$0 today, free for {days} days. Card required. Cancel anytime.", { days }),
    };
  }
  return {
    confirmLabel: t("Continue to checkout"),
    note: offer?.trialAvailable === false ? t("Billed today. Cancel anytime.") : t("Card required. Cancel anytime."),
  };
}

/** Ranked like the onboarding Pro step: the data first, then what reads it. */
const PRO_FEATURES: Array<{ label: string; value: string }> = [
  { label: "Real-time data", value: "Free runs 15 min behind on quotes, 12 h on news" },
  { label: "Earnings calls", value: "Full transcripts, summaries and guidance" },
  { label: "Ask Gloom, MCP", value: "The Pro model, and Gloom's tools in your agents" },
  { label: "Flow and X", value: "Options flow, the X feed and sentiment" },
];

/** The feature list, translated. */
function proFeatureRows(): Array<{ label: string; value: string }> {
  return PRO_FEATURES.map((feature) => ({ label: feature.label, value: t(feature.value) }));
}

/**
 * A feature on a sheet too narrow for its line (a phone, a small terminal):
 * the value wraps beside its label instead of being cut mid-sentence.
 */
function WrappedFeatureRow({ label, value, width }: { label: string; value: string; width: number }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" width={width}>
      <Box width={FEATURE_LABEL_WIDTH} flexShrink={0}>
        <Text fg={colors.textDim}>{t(label)}</Text>
      </Box>
      <Box width={Math.max(1, width - FEATURE_LABEL_WIDTH)} flexShrink={1} flexDirection="column">
        <Text fg={colors.text} wrapText>{value}</Text>
      </Box>
    </Box>
  );
}

/** Pricing and this account's trial and billing state; never rejects, unknowns come back null. */
export async function loadUpgradeOffer(): Promise<UpgradeOffer> {
  const [pricing, account] = await Promise.allSettled([
    apiClient.getCloudPricing(),
    apiClient.getCloudAccountPlan(),
  ]);
  const plan: CloudAccountPlan | null = account.status === "fulfilled" ? account.value : null;
  return {
    pricing: pricing.status === "fulfilled" ? pricing.value : null,
    trialAvailable: typeof plan?.trialAvailable === "boolean" ? plan.trialAvailable : null,
    paymentFailed: plan?.paymentFailed === true,
  };
}

/** What the sheet resolves with: the interval to check out on, or "free" for an account and no Pro. */
type UpgradeChoice = CloudBillingInterval | "free";

function UpgradeDialog({
  dialogId,
  resolve,
  dismiss,
  initialInterval,
  loadOffer,
  width,
  signedOut = false,
}: PromptContext<UpgradeChoice | null> & {
  initialInterval: CloudBillingInterval;
  loadOffer: () => Promise<UpgradeOffer>;
  width: number;
  /** Nobody is signed in: the sheet offers the trial or a free account, and its close button is the way out. */
  signedOut?: boolean;
}) {
  useAppLanguage();
  const [interval, setBillingInterval] = useState<CloudBillingInterval>(initialInterval);
  const [offer, setOffer] = useState<UpgradeOffer | null>(null);

  useEffect(() => {
    let live = true;
    const show = (loaded: UpgradeOffer) => {
      if (live) setOffer(loaded);
    };
    // A failed request still opens the dialog, with list prices.
    loadOffer().then(show, (error: unknown) => {
      logFailure("account-upgrade", "Upgrade offer request failed")(error);
      show({ pricing: null, trialAvailable: null, paymentFailed: false });
    });
    return () => {
      live = false;
    };
  }, [loadOffer]);

  const copy = upgradeDialogCopy(offer, interval, new Date(), signedOut);
  const confirm = useCallback(() => {
    if (offer) resolve(interval);
  }, [interval, offer, resolve]);

  useDialogKeyboard((event) => {
    if (event.name === "return" || event.name === "enter") {
      event.stopPropagation?.();
      confirm();
      return;
    }
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
      return;
    }
    if (signedOut && isPlainKey(event, SIGN_UP_FREE_KEY)) {
      event.stopPropagation?.();
      resolve("free");
    }
  }, { scope: dialogId });

  const monthsFree = monthsFreeYearly(offer?.pricing);
  const features = proFeatureRows();
  const featuresFit = features.every((feature) => FEATURE_LABEL_WIDTH + displayWidth(feature.value) <= width);
  const footer = copy.showPlan
    ? tf("Enter {action} · ←/→ billing · Esc not now", { action: copy.confirmLabel.toLowerCase() })
    : tf("Enter {action} · Esc not now", { action: copy.confirmLabel.toLowerCase() });

  return (
    <DialogFrame title={copy.title} subtitle={copy.subtitle} footer={footer} desktopFooter={null} onClose={signedOut ? dismiss : undefined}>
      <Box flexDirection="column" width={width}>
        {copy.showPlan ? (
          <>
            <SegmentedControl
              options={[
                { label: t("Monthly"), value: "month" },
                {
                  label: monthsFree > 0 ? tf("Yearly, {months} months free", { months: monthsFree }) : t("Yearly"),
                  value: "year",
                },
              ]}
              value={interval}
              onChange={(value) => setBillingInterval(value === "year" ? "year" : "month")}
              focused
              shortcutScope={dialogId}
            />
            <Box height={1} />
            {features.map((feature) => featuresFit ? (
              <KeyValueRow
                key={feature.label}
                label={feature.label}
                value={feature.value}
                labelWidth={FEATURE_LABEL_WIDTH}
                width={width}
                emphasis={false}
              />
            ) : (
              <WrappedFeatureRow key={feature.label} label={feature.label} value={feature.value} width={width} />
            ))}
            <Box height={1} />
          </>
        ) : null}
        <DialogActions>
          <Button label={copy.confirmLabel} variant="primary" desktopShortcut="Enter" disabled={!offer} onPress={confirm} />
          {signedOut
            ? <Button label="Sign up free" variant="secondary" shortcut={SIGN_UP_FREE_KEY} onPress={() => resolve("free")} />
            : <Button label="Not now" variant="secondary" desktopShortcut="Esc" onPress={dismiss} />}
        </DialogActions>
      </Box>
    </DialogFrame>
  );
}

/** The sheet's width: its content's, or what a narrow terminal leaves. */
function upgradeSheetWidth(viewportWidth: number | undefined): number {
  return Math.max(
    36,
    Math.min(CONTENT_WIDTH, (viewportWidth ?? CONTENT_WIDTH + TERMINAL_DIALOG_CHROME + 4) - TERMINAL_DIALOG_CHROME - 4),
  );
}

/** The prices alone: signed out there is no account to ask about. Never rejects. */
async function loadSignedOutOffer(): Promise<UpgradeOffer> {
  const pricing = await apiClient.getCloudPricing()
    .catch(logFailure("account-upgrade", "Pricing request failed", null));
  return { pricing, trialAvailable: null, paymentFailed: false };
}

async function promptUpgradeSheet(
  dialog: DialogApi,
  options: { interval?: CloudBillingInterval; viewportWidth?: number; signedOut?: boolean },
): Promise<UpgradeChoice | null> {
  const width = upgradeSheetWidth(options.viewportWidth);
  const choice = await dialog
    .prompt<UpgradeChoice | null>({
      closeOnClickOutside: true,
      // The terminal host defaults to 60 columns; the desktop sizes to the content.
      style: { width: width + TERMINAL_DIALOG_CHROME },
      content: (context) => (
        <UpgradeDialog
          {...context}
          initialInterval={options.interval ?? "month"}
          loadOffer={options.signedOut ? loadSignedOutOffer : loadUpgradeOffer}
          width={width}
          signedOut={options.signedOut}
        />
      ),
    })
    .catch(logFailure("account-upgrade", "Upgrade prompt failed", null));
  return choice ?? null;
}

/**
 * Shows the sheet and resolves with the interval to check out on, or null
 * when the person backs out (Not now, Esc, a click outside).
 */
export async function promptCloudUpgrade(
  dialog: DialogApi,
  options: { interval?: CloudBillingInterval; viewportWidth?: number } = {},
): Promise<CloudBillingInterval | null> {
  const choice = await promptUpgradeSheet(dialog, options);
  return choice === "free" ? null : choice;
}

/**
 * The sheet for someone with no account yet. Resolves with the interval they
 * chose a trial on, "free" when they would rather only sign up, or null when
 * they close it.
 */
export async function promptSignedOutUpgrade(
  dialog: DialogApi,
  options: { interval?: CloudBillingInterval; viewportWidth?: number } = {},
): Promise<CloudBillingInterval | "free" | null> {
  return promptUpgradeSheet(dialog, { ...options, signedOut: true });
}
