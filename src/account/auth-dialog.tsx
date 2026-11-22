/**
 * Shared email/password auth dialog plus the request bridge that lets commands
 * (which run outside the React tree) open it. `AuthDialogHost` is mounted by
 * the shell for the life of the app and owns the actual dialog, mirroring the
 * QR sign-in dialog host. The form body itself lives in `auth-form`, which the
 * hosted terminal's sign-in gate reuses.
 */
import { useEffect, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../api-client";
import { DialogFrame } from "../components/ui/frame";
import { useAppLanguage } from "../i18n/react";
import { useDialog, type PromptContext } from "../ui/dialog";
import { clickOutsideWhileClean } from "../ui/dialog-stack";
import { AuthForm, authFormTitle } from "./auth-form";
import type { AccountMode } from "./auth-model";
import { CloudVerificationPanel } from "./verification-panel";
import { markHeardFromDue } from "./heard-from";

function AuthDialog({
  initialMode,
  reason,
  confirm,
  resolve,
  dismiss,
  onCleanChange,
  onAccount,
}: PromptContext<AuthUser | undefined> & {
  initialMode: AccountMode;
  reason?: string;
  /** Opens on the confirmation step for this signed-in account, with a fresh link on its way. */
  confirm?: AuthUser;
  onCleanChange: (clean: boolean) => void;
  /** The account the form signed in or up, before its email is confirmed too. */
  onAccount: (user: AuthUser) => void;
}) {
  useAppLanguage();
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [verifyingUser, setVerifyingUser] = useState<AuthUser | null>(confirm ?? null);
  const [typed, setTyped] = useState(false);
  // A click outside closes it only while it is clean: never with something typed, nor once the account
  // waits on its emailed code.
  useEffect(() => onCleanChange(!typed && !verifyingUser), [onCleanChange, typed, verifyingUser]);

  // The close button always closes it, so a mouse is never trapped in it.
  if (verifyingUser) return <DialogFrame title={`Confirm ${verifyingUser.email}`} onClose={dismiss}>
    <CloudVerificationPanel onVerified={resolve} onContinueFree={() => resolve(verifyingUser)} sendOnOpen={!!confirm} />
  </DialogFrame>;

  return (
    <DialogFrame title={authFormTitle(mode)} subtitle={reason} onClose={dismiss}>
      <AuthForm
        initialMode={initialMode}
        onModeChange={setMode}
        onSignedIn={(user) => {
          onAccount(user);
          if (user.emailVerified) resolve(user);
          else setVerifyingUser(user);
        }}
        onEscape={dismiss}
        onTypedChange={setTyped}
      />
    </DialogFrame>
  );
}

export interface AuthDialogRequest {
  mode?: AccountMode;
  /** What asked for it, under the title: the delayed mark says what is delayed and by how much. */
  reason?: string;
  onSignedIn?: (user: AuthUser) => void;
  /** The sign-in goes on to a checkout: nothing else is asked before it. */
  checkout?: boolean;
  /** Set by `requestEmailConfirmation`: the dialog opens on this account's confirmation step. */
  confirm?: AuthUser;
}

const authDialogListeners = new Set<(request: AuthDialogRequest) => void>();
/** How many hosts show the dialog now; a request while one does is ignored. */
let openAuthDialogs = 0;

/** Returns false when no dialog host is mounted, so callers can fall back. */
export function requestAuthDialog(request: AuthDialogRequest = {}): boolean {
  if (authDialogListeners.size === 0) return false;
  for (const listener of authDialogListeners) listener(request);
  return true;
}

/**
 * Opens the dialog on its confirmation step for the signed-in account whose
 * email is still unconfirmed, and sends it the link again: the address in the
 * title, and the terminal carries on by itself once the link is opened. False
 * when there is no such account or no dialog host, so the caller can fall back.
 */
export function requestEmailConfirmation(): boolean {
  const user = apiClient.getCurrentUser();
  if (!user || user.emailVerified) return false;
  return requestAuthDialog({ confirm: user });
}

/** Whether a host is mounted to show the dialog, for a flow that must not start what it could not finish. */
export function hasAuthDialogHost(): boolean {
  return authDialogListeners.size > 0;
}

/** Whether the dialog is on screen, so a press that would only ask for it again can do nothing. */
export function isAuthDialogOpen(): boolean {
  return openAuthDialogs > 0;
}

/** Takes the requests a host would, for a test that signs in without the form. */
export function interceptAuthDialogForTests(listener: (request: AuthDialogRequest) => void): () => void {
  authDialogListeners.add(listener);
  return () => {
    authDialogListeners.delete(listener);
  };
}

export function AuthDialogHost() {
  const dialog = useDialog();
  const openRef = useRef(false);

  useEffect(() => {
    const listener = (request: AuthDialogRequest) => {
      if (openRef.current) return;
      openRef.current = true;
      openAuthDialogs += 1;
      const { closeOnClickOutside, setClean } = clickOutsideWhileClean();
      // Signed up, even when the dialog then closes before the email is confirmed.
      let account: AuthUser | null = null;
      void dialog
        .prompt<AuthUser | undefined>({
          closeOnClickOutside,
          content: (context: unknown) => (
            <AuthDialog
              {...(context as PromptContext<AuthUser | undefined>)}
              initialMode={request.mode ?? "login"}
              reason={request.reason}
              confirm={request.confirm}
              onCleanChange={setClean}
              onAccount={(user) => {
                account = user;
              }}
            />
          ),
        })
        .then((user) => {
          if (user) request.onSignedIn?.(user);
          // Where it heard about Gloom, once the dialog and what follows it have closed.
          // An account that only came back to confirm its email was asked when it signed up.
          const signedIn = user ?? account;
          if (signedIn && !request.checkout && !request.confirm) markHeardFromDue(signedIn.id);
        })
        .finally(() => {
          openRef.current = false;
          openAuthDialogs -= 1;
        });
    };
    authDialogListeners.add(listener);
    return () => {
      authDialogListeners.delete(listener);
    };
  }, [dialog]);

  return null;
}
