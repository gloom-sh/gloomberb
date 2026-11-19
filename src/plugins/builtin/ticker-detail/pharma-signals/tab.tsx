import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { requestAuthDialog, requestEmailConfirmation } from "../../../../account/auth-dialog";
import { apiClient } from "../../../../api-client";
import { usePlanAccess } from "../../../../api-client/plan-access";
import { isEmailVerificationRequired } from "../../../../api-client/product-waitlist";
import { Button, confirmDialog, PaneStatusBody, usePaneStatusFooter } from "../../../../components";
import { usePaneRefreshKey } from "../../../../components/data-table/table-pane";
import { t } from "../../../../i18n";
import { usePluginAppActions } from "../../../../public/react";
import { colors } from "../../../../theme/colors";
import type { TickerResearchTabProps } from "../../../../types/plugin";
import { Box, Text, TextAttributes } from "../../../../ui";
import { useOptionalDialog } from "../../../../ui/dialog";
import { logFailure } from "../../../../utils/log-failure";
import { useProductWaitlist, type WaitlistClient } from "./waitlist";

export const PharmaWaitlistClientContext = createContext<WaitlistClient | null>(null);

const PRODUCT = "pharma-signals";
const PLANNED = "Planned: alerts the day a trial's endpoint, enrollment, dates or status change, and cash runway against the next catalyst.";
const RESEND_VERIFICATION = "Resend Verification Email";

function subscribeAccount(onChange: () => void): () => void {
  return apiClient.subscribeCurrentUser(onChange);
}

function currentAccount(): string | null {
  return apiClient.getCurrentUser()?.id ?? null;
}

/** The consent itself: what joining costs (nothing now) and the one email it allows. */
function JoinDialogBody() {
  return (
    <Box flexDirection="column">
      <Text fg={colors.text} wrapText>{t("Planned price: $50/month on top of Pro, once it launches.")}</Text>
      <Box height={1} />
      <Text fg={colors.positive} attributes={TextAttributes.BOLD} wrapText>{t("Nothing is charged now. No card needed.")}</Text>
      <Box height={1} />
      <Text fg={colors.textDim} wrapText>{t("We email you once, only if it launches. Nothing else.")}</Text>
    </Box>
  );
}

/**
 * The Signals tab of a drug developer's research pane: an add-on that is not
 * built, said plainly, with a no-charge waitlist. Nothing in it is data, so
 * it shows no rows, real or made up. Joining asks first, every time, and
 * never happens at sign-in: signed out, the button only opens the sign-in.
 * The launch email goes to the account's address, so an unverified one is
 * asked to verify it first: the app sends nothing for an address it knows is
 * unverified, and says the same when the service refuses one it thought was.
 */
export function PharmaSignalsResearchTab({ width, height, focused }: TickerResearchTabProps) {
  const client = useContext(PharmaWaitlistClientContext) ?? apiClient;
  const account = useSyncExternalStore(subscribeAccount, currentAccount, currentAccount);
  const access = usePlanAccess();
  const waitlist = useProductWaitlist(client, PRODUCT, account && access.emailVerified ? account : null);
  const needsVerification = !!account && (!access.emailVerified || waitlist.unverified);
  const { change, retry } = waitlist;
  const dialog = useOptionalDialog();
  const { openCommandBar, notify } = usePluginAppActions();
  // The join dialog is open: the key or press that answered it does not open another.
  const asking = useRef(false);

  usePaneRefreshKey(retry, { focused });
  usePaneStatusFooter({ registrationId: "pharma-signals", loading: waitlist.loading, error: waitlist.error });

  const failed = useCallback((message: string, unverifiedMessage: string, error: unknown) => {
    if (isEmailVerificationRequired(error)) {
      notify({ body: t(unverifiedMessage), type: "error", desktop: "never" });
      return;
    }
    logFailure("pharma-signals", message)(error);
    notify({ body: t(message), type: "error", desktop: "never" });
  }, [notify]);

  const join = useCallback(() => {
    if (!account) {
      if (!requestAuthDialog({ mode: "login" })) openCommandBar("Log In");
      return;
    }
    if (!dialog || asking.current) return;
    asking.current = true;
    // The account the person decides as: a sign-in elsewhere while the dialog is open sends nothing.
    const decidedAs = account;
    confirmDialog(dialog, {
      title: t("Join the pharma signals waitlist"),
      body: <JoinDialogBody />,
      confirmLabel: t("Join waitlist"),
      cancelLabel: t("Not now"),
      confirmVariant: "primary",
      // An opt-in: a stray Enter answers Not now; only `y` or the button joins.
      defaultAction: "cancel",
    })
      .then((confirmed) => {
        // Released a turn after the answer, once the key that gave it has gone everywhere it goes.
        setTimeout(() => { asking.current = false; }, 0);
        return confirmed ? change(true, decidedAs) : null;
      })
      .catch((error: unknown) => failed("Couldn't join the waitlist. Try again.", "Verify your email to join the waitlist.", error));
  }, [account, change, dialog, failed, openCommandBar]);

  const leave = useCallback(() => {
    if (!account) return;
    change(false, account)
      .catch((error: unknown) => failed("Couldn't leave the waitlist. Try again.", "Verify your email to leave the waitlist.", error));
  }, [account, change, failed]);

  if (needsVerification) {
    return (
      <PaneStatusBody
        empty
        width={width}
        height={height}
        emptyTitle={t("Verify your email to join the pharma signals waitlist.")}
        emptyMessage={t(PLANNED)}
        // The link again, and the dialog that names the address and waits for it.
        actions={<Button label={t(RESEND_VERIFICATION)} onPress={() => { if (!requestEmailConfirmation()) openCommandBar(RESEND_VERIFICATION); }} />}
      />
    );
  }

  if (waitlist.joined) {
    return (
      <PaneStatusBody
        empty
        width={width}
        height={height}
        emptyTitle={t("You're on the pharma signals waitlist.")}
        emptyMessage={t("We email you once, only if it launches. Nothing is charged.")}
        actions={(
          <Button
            label={t("Leave waitlist")}
            variant="secondary"
            pending={waitlist.pending === "leave"}
            pendingLabel={t("Leaving…")}
            onPress={leave}
          />
        )}
      />
    );
  }

  const known = !account || waitlist.joined === false;
  return (
    <PaneStatusBody
      empty
      width={width}
      height={height}
      emptyTitle={t("Pharma signals are not available yet.")}
      emptyMessage={t(PLANNED)}
      retry={waitlist.error ? { onRetry: retry } : undefined}
      actions={known ? (
        <Button
          label={account ? t("Join waitlist") : t("Log in to join")}
          pending={waitlist.pending === "join"}
          pendingLabel={t("Joining…")}
          onPress={join}
        />
      ) : undefined}
    />
  );
}
