import { confirmDialog } from "../../../components";
import { formatTrialEnd } from "../../../account/billing";
import { t, tf } from "../../../i18n";
import type { PlanAccess } from "../../../api-client/plan-rules";
import type { DialogApi } from "../../../ui/dialog";

/**
 * Ends a Pro trial the way the account page on gloom.sh does: first a warning
 * that it ends the trial and Pro now, and only a confirmed answer reaches the
 * server. Ending Pro cannot be undone, so a stray Enter keeps the trial; `y`
 * or End Trial Now ends it. Null when the person kept the trial, or when no
 * trial is running (a stale key or click after it ended), which asks nothing.
 */
export async function endTrialAfterWarning(
  dialog: DialogApi,
  trial: Pick<PlanAccess, "isTrialActive" | "trialEndsAt">,
  end: () => Promise<{ endedNow?: boolean }>,
  onConfirmed?: () => void,
): Promise<{ endedNow: boolean } | null> {
  if (!trial.isTrialActive) return null;
  const date = formatTrialEnd(trial.trialEndsAt);
  const confirmed = await confirmDialog(dialog, {
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
  });
  if (!confirmed) return null;
  onConfirmed?.();
  const result = await end();
  return { endedNow: result.endedNow === true };
}
