import { confirmDialogWithAnswer } from "../../../components/ui/confirm-dialog";
import { formatTrialEnd } from "../../../account/billing";
import { t, tf } from "../../../i18n";
import { CLOUD_CANCEL_COMMENT_MAX } from "../../../api-client";
import type { CloudCancelFeedback, CloudCancelReason } from "../../../api-client";
import type { PlanAccess } from "../../../api-client/plan-rules";
import type { DialogApi } from "../../../ui/dialog";

/** The reasons gloom.sh's cancel window offers, in its words and order. */
const CANCEL_REASONS: ReadonlyArray<{ id: CloudCancelReason; label: string }> = [
  { id: "bugs", label: "Bugs or reliability" },
  { id: "missing_feature", label: "Missing feature" },
  { id: "too_expensive", label: "Too expensive" },
  { id: "not_using", label: "Not using it enough" },
  { id: "temporary", label: "Only needed it temporarily" },
  { id: "other", label: "Other" },
];

/**
 * Ends a Pro trial the way the account page on gloom.sh does: first a warning
 * that it ends the trial and Pro now, and only a confirmed answer reaches the
 * server. Ending Pro cannot be undone, so a stray Enter keeps the trial; `y`
 * or End Trial Now ends it. The warning also asks why, as the cancel window
 * on gloom.sh does, but nothing there is required and it adds no step: the
 * reason and note picked go with the request, and none go when none were.
 * Null when the person kept the trial, or when no trial is running (a stale
 * key or click after it ended), which asks nothing.
 */
export async function endTrialAfterWarning(
  dialog: DialogApi,
  trial: Pick<PlanAccess, "isTrialActive" | "trialEndsAt">,
  end: (feedback: CloudCancelFeedback) => Promise<{ endedNow?: boolean }>,
  onConfirmed?: () => void,
): Promise<{ endedNow: boolean } | null> {
  if (!trial.isTrialActive) return null;
  const date = formatTrialEnd(trial.trialEndsAt);
  const answer = await confirmDialogWithAnswer(dialog, {
    closeOnClickOutside: false,
    title: t("Cancel Trial?"),
    body: [
      t("Cancelling ends your trial and Pro now."),
      date
        ? tf("If you keep your trial, you can still cancel before {date} without being charged.", { date })
        : t("If you keep your trial, you can still cancel before it ends without being charged."),
    ],
    confirmLabel: t("End Trial Now"),
    cancelLabel: t("Keep Trial"),
    confirmVariant: "danger",
    defaultAction: "cancel",
    question: {
      label: "What made you decide to cancel? (optional)",
      choices: CANCEL_REASONS,
      notePlaceholder: "Anything else? (optional)",
      noteMaxLength: CLOUD_CANCEL_COMMENT_MAX,
    },
  });
  if (!answer) return null;
  onConfirmed?.();
  const reason = CANCEL_REASONS.find(({ id }) => id === answer.choice)?.id;
  const result = await end({
    ...(reason ? { reason } : {}),
    ...(answer.note ? { comment: answer.note } : {}),
  });
  return { endedNow: result.endedNow === true };
}
