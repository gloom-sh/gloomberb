/**
 * The Pro pitch between an upgrade button and Stripe. Signed-in free accounts
 * used to land straight on a card form with nothing on it but a price; this
 * says what Pro adds, what today costs and when the first charge lands, and
 * only then opens checkout.
 */
import { useCallback, useEffect, useState } from "react";
import { apiClient, type CloudAccountPlan, type CloudPricing } from "../../../api-client";
import { Button } from "../../../components/ui/button";
import { KeyValueRow } from "../../../components/ui/display";
import { DialogFrame } from "../../../components/ui/frame";
import { SegmentedControl } from "../../../components/ui/toggle";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { Box } from "../../../ui";
import { type DialogApi, type PromptContext, useDialogKeyboard } from "../../../ui/dialog";
import {
  type CloudBillingInterval,
  formatCloudPrice,
  formatTrialEnd,
  monthsFreeYearly,
  trialDaysOf,
} from "../account-management/model";

const CONTENT_WIDTH = 64;
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
 * is billed on the spot, and one we could not check might be.
 */
export function upgradeDialogCopy(
  offer: UpgradeOffer | null,
  interval: CloudBillingInterval,
  now: Date,
): UpgradeDialogCopy {
  if (!offer) {
    return { title: t("Upgrade to Pro"), subtitle: t("Loading…"), confirmLabel: t("Start free trial"), showPlan: true };
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
  if (offer.trialAvailable === true) {
    const days = trialDaysOf(offer.pricing);
    const firstCharge = formatTrialEnd(new Date(now.getTime() + days * MS_PER_DAY));
    return {
      title: tf("Try Pro free for {days} days", { days }),
      subtitle: tf("$0 today, then {price} from {date}. Cancel before and you pay nothing.", {
        price,
        date: firstCharge ?? "",
      }),
      confirmLabel: t("Start free trial"),
      showPlan: true,
    };
  }
  return {
    title: t("Upgrade to Pro"),
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

function UpgradeDialog({
  dialogId,
  resolve,
  dismiss,
  initialInterval,
  loadOffer,
  width,
}: PromptContext<CloudBillingInterval | null> & {
  initialInterval: CloudBillingInterval;
  loadOffer: () => Promise<UpgradeOffer>;
  width: number;
}) {
  useAppLanguage();
  const [interval, setBillingInterval] = useState<CloudBillingInterval>(initialInterval);
  const [offer, setOffer] = useState<UpgradeOffer | null>(null);

  useEffect(() => {
    let live = true;
    void loadOffer()
      .catch((): UpgradeOffer => ({ pricing: null, trialAvailable: null, paymentFailed: false }))
      .then((loaded) => {
        if (live) setOffer(loaded);
      });
    return () => {
      live = false;
    };
  }, [loadOffer]);

  const copy = upgradeDialogCopy(offer, interval, new Date());
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
    }
  }, { scope: dialogId });

  const monthsFree = monthsFreeYearly(offer?.pricing);
  const footer = copy.showPlan
    ? tf("Enter {action} · ←/→ billing · Esc not now", { action: copy.confirmLabel.toLowerCase() })
    : tf("Enter {action} · Esc not now", { action: copy.confirmLabel.toLowerCase() });

  return (
    <DialogFrame title={copy.title} subtitle={copy.subtitle} footer={footer}>
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
            {PRO_FEATURES.map((feature) => (
              <KeyValueRow
                key={feature.label}
                label={feature.label}
                value={t(feature.value)}
                labelWidth={FEATURE_LABEL_WIDTH}
                width={width}
                emphasis={false}
              />
            ))}
            <Box height={1} />
          </>
        ) : null}
        <Box flexDirection="row" gap={1}>
          <Button label={copy.confirmLabel} variant="primary" disabled={!offer} onPress={confirm} />
          <Button label="Not now" variant="secondary" onPress={dismiss} />
        </Box>
      </Box>
    </DialogFrame>
  );
}

/**
 * Shows the sheet and resolves with the interval to check out on, or null
 * when the person backs out (Not now, Esc, a click outside).
 */
export async function promptCloudUpgrade(
  dialog: DialogApi,
  options: { interval?: CloudBillingInterval; viewportWidth?: number } = {},
): Promise<CloudBillingInterval | null> {
  const width = Math.max(
    36,
    Math.min(CONTENT_WIDTH, (options.viewportWidth ?? CONTENT_WIDTH + TERMINAL_DIALOG_CHROME + 4) - TERMINAL_DIALOG_CHROME - 4),
  );
  const interval = await dialog
    .prompt<CloudBillingInterval | null>({
      closeOnClickOutside: true,
      // The terminal host defaults to 60 columns; the desktop sizes to the content.
      style: { width: width + TERMINAL_DIALOG_CHROME },
      content: (context) => (
        <UpgradeDialog
          {...context}
          initialInterval={options.interval ?? "month"}
          loadOffer={loadUpgradeOffer}
          width={width}
        />
      ),
    })
    .catch(() => null);
  return interval ?? null;
}
