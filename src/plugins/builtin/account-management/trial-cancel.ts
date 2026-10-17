import { confirmDialog } from "../../../components";
import { formatTrialEnd } from "../../../account/billing";
import { t, tf } from "../../../i18n";
import type { DialogApi } from "../../../ui/dialog";

/**
 * Ends a Pro trial the way the account page on gloom.sh does: first a warning
 * that it ends the trial and Pro now, and only a confirmed answer reaches the
 * server. Ending Pro cannot be undone, so a stray Enter keeps the trial; `y`
 * or End Trial Now ends it. Null when the person kept the trial.
 */
export async function endTrialAfterWarning(
  dialog: DialogApi,
  trialEndsAt: Date | null,
  end: () => Promise<{ endedNow?: boolean }>,
  onConfirmed?: () => void,
): Promise<{ endedNow: boolean } | null> {
  const date = formatTrialEnd(trialEndsAt);
  const confirmed = await confirmDialog(dialog, {
    closeOnClickOutside: false,
    title: t("Cancel Trial?"),
    body: [
      t("Cancelling ends your trial and Pro now."),
      date
        ? tf("To keep trying Pro, cancel any time before {date} and you still won't be charged.", { date })
        : t("To keep trying Pro, cancel any time before it ends and you still won't be charged."),
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
