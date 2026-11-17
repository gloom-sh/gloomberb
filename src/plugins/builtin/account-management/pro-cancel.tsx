import { confirmDialog, confirmDialogChoice, confirmDialogWithAnswer } from "../../../components/ui/confirm-dialog";
import { formatUsdCents } from "../../../account/billing";
import { t, tf } from "../../../i18n";
import {
  CLOUD_CANCEL_COMMENT_MAX,
  type CloudCancelFeedback,
  type CloudCancelReason,
  type CloudKeptPrice,
  type CloudRetentionOffer,
  type CloudRetentionOfferAnswer,
} from "../../../api-client";
import { colors } from "../../../theme/colors";
import { Text } from "../../../ui";
import type { DialogApi } from "../../../ui/dialog";
import { formatShortDate } from "../../../utils/datetime-format";
import { CANCEL_REASONS } from "./trial-cancel";

/** How long the reason step waits for the offer once it is answered, as gloom.sh's window does. */
const OFFER_WAIT_MS = 5_000;

/** One honest opening line per reason, gloom.sh's; the offer itself says the rest. */
const OPENING_LINES: Record<CloudCancelReason, string> = {
  bugs: "Sorry Gloom got in your way. Gloom is still new, and we know some rough edges remain.",
  missing_feature: "Sorry Gloom does not do what you need yet. It is still new and we are building it out.",
  too_expensive: "Fair. The price has to be worth it.",
  not_using: "Fair. It has to earn the time it takes.",
  temporary: "Makes sense. Thanks for giving it a run.",
  other: "Thanks for telling us.",
};

/** What the paid cancel flow talks to: gloom.sh's cancel window's three requests. */
export interface ProCancelApi {
  /** The offer and kept price for this subscription; the server counts the flow as started. */
  retentionOffer(signal: AbortSignal): Promise<CloudRetentionOfferAnswer>;
  acceptOffer(feedback: CloudCancelFeedback): Promise<{ offer: CloudRetentionOffer | null; extendedTrialEndsAt: string | null }>;
  cancel(feedback: CloudCancelFeedback): Promise<unknown>;
}

export interface ProCancelHooks {
  /** A request the person asked for is out: the pane says so and holds its buttons. */
  onWorking?(message: string): void;
}

/** How the flow ended, in words for the pane's message line; null when Pro was kept as it was. */
export type ProCancelOutcome =
  | { kind: "cancelled"; message: string }
  | { kind: "saved"; message: string }
  | null;

function priceWithPeriod(cents: number, interval: CloudKeptPrice["interval"]): string {
  const amount = formatUsdCents(cents);
  return interval === "year" ? tf("{amount}/yr", { amount }) : tf("{amount}/mo", { amount });
}

/** The kept price against what a new subscriber pays, and what cancelling gives up. */
function keptPriceLines(kept: CloudKeptPrice): string[] {
  const list = priceWithPeriod(kept.listAmount, kept.interval);
  return [
    tf("Your price is {price}. New subscribers pay {list}.", { price: priceWithPeriod(kept.amount, kept.interval), list }),
    tf("If you cancel, you lose this price. Coming back costs {list}.", { list }),
  ];
}

/** The offer in gloom.sh's words: its opening line for the reason given, the offer, and its button. */
function offerCopy(offer: CloudRetentionOffer, reason: CloudCancelReason | undefined, date: string) {
  return {
    lines: [
      ...(reason ? [t(OPENING_LINES[reason])] : []),
      offer === "trial_extension"
        ? tf("We would like to give you 14 more days free while we improve it. You will not be charged until {date}.", { date })
        : tf("Take 50% off your next three months while we improve it. Your payment on {date} drops to half price.", { date }),
    ],
    accept: offer === "trial_extension" ? t("Extend My Trial") : t("Get 50% Off for 3 Months"),
  };
}

function dateLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : formatShortDate(date);
}

/**
 * Cancels a paid Pro plan the way gloom.sh's cancel window does, in the same
 * three steps and with the same requests: why (the reason and a note, both
 * optional here as in the trial's warning), the one save offer the server has
 * for this subscription when it has one, then a plain confirmation with the
 * date Pro stays on to and the price it gives up. The offer is asked for as
 * the flow opens, so the second step never waits on it for long; one that
 * does not come counts as none, so nobody is held mid-cancel. Esc or Keep
 * leaves at any step with nothing sent.
 */
export async function cancelProAfterSteps(
  dialog: DialogApi,
  plan: { currentPeriodEnd: string | null | undefined },
  api: ProCancelApi,
  hooks: ProCancelHooks = {},
): Promise<ProCancelOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFFER_WAIT_MS);
  const offerLookup: Promise<CloudRetentionOfferAnswer | null> = api.retentionOffer(controller.signal).catch(() => {
    // Intentional ignore: a failed or slow offer lookup is no offer, never a stuck cancel.
    return null;
  });
  try {
    const date = dateLabel(plan.currentPeriodEnd);
    const until = date
      ? tf("Pro stays on until {date}.", { date })
      : t("Pro stays on until the end of the billing period.");
    const answer = await confirmDialogWithAnswer(dialog, {
      closeOnClickOutside: false,
      title: t("Cancel Pro?"),
      body: [until],
      confirmLabel: t("Continue"),
      cancelLabel: t("Keep Pro"),
      confirmVariant: "primary",
      footer: t("Enter continue · Tab note · Esc keep Pro"),
      wrapButtons: true,
      question: {
        label: "What made you decide to cancel? (optional)",
        choices: CANCEL_REASONS,
        notePlaceholder: "Anything else? (optional)",
        noteMaxLength: CLOUD_CANCEL_COMMENT_MAX,
      },
    });
    if (!answer) return null;
    const reason = CANCEL_REASONS.find(({ id }) => id === answer.choice)?.id;
    const feedback: CloudCancelFeedback = {
      ...(reason ? { reason } : {}),
      ...(answer.note ? { comment: answer.note } : {}),
    };

    const found = await offerLookup;
    let status: string | undefined;
    if (found?.offer) {
      const offerDate = found.offer === "trial_extension" ? dateLabel(found.extendedTrialEndsAt) : date;
      const copy = offerCopy(found.offer, reason, offerDate ?? t("your next billing date"));
      const choice = await confirmDialogChoice(dialog, {
        closeOnClickOutside: false,
        title: t("Cancel Pro?"),
        body: copy.lines,
        confirmLabel: copy.accept,
        cancelLabel: t("Continue Cancellation"),
        confirmVariant: "primary",
        footer: t("Enter take the offer · n continue · Esc close"),
        wrapButtons: true,
      });
      if (choice === null) return null;
      if (choice === "confirm") {
        hooks.onWorking?.(t("Applying..."));
        try {
          const taken = await api.acceptOffer(feedback);
          const extended = dateLabel(taken.extendedTrialEndsAt);
          return {
            kind: "saved",
            message: taken.offer === "trial_extension"
              ? extended ? tf("Trial extended to {date}.", { date: extended }) : t("Trial extended.")
              : t("50% off applied to your next three months."),
          };
        } catch (error) {
          // The offer went away (used already, or the plan changed): the honest
          // move is to let them finish cancelling, not to trap them here.
          status = error instanceof Error && error.message ? error.message : t("Offer could not be applied.");
        }
      }
    }

    const confirmed = await confirmDialog(dialog, {
      closeOnClickOutside: false,
      title: t("Cancel Pro?"),
      body: [
        ...(found?.keptPrice ? keptPriceLines(found.keptPrice) : []),
        date
          ? tf("Pro stays on until {date}. Cancelling now stops the renewal after that date.", { date })
          : t("Pro stays on until the end of the billing period. Cancelling now stops the renewal after that."),
      ],
      ...(status ? { status: <Text fg={colors.textDim} wrapText>{status}</Text> } : {}),
      confirmLabel: t("Cancel Subscription"),
      cancelLabel: t("Keep My Subscription"),
      confirmVariant: "danger",
      footer: t("y cancel · Enter or Esc keep Pro"),
      wrapButtons: true,
      // Keeping is the primary answer, as on gloom.sh: a stray Enter keeps Pro.
      defaultAction: "cancel",
    });
    if (!confirmed) return null;
    hooks.onWorking?.(t("Cancelling..."));
    await api.cancel(feedback);
    return {
      kind: "cancelled",
      message: date ? tf("Cancelled. Pro stays on until {date}.", { date }) : t("Cancelled. Pro stays on until the end of the billing period."),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
