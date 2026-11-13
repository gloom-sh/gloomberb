/**
 * Shared email/password auth dialog plus the request bridge that lets commands
 * (which run outside the React tree) open it. `AuthDialogHost` is mounted by
 * the shell for the life of the app and owns the actual dialog, mirroring the
 * QR sign-in dialog host. The form body itself lives in `auth-form`, which the
 * hosted terminal's sign-in gate reuses.
 */
import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../api-client";
import { DialogFrame } from "../components/ui/frame";
import { useAppLanguage } from "../i18n/react";
import { useDialog, type PromptContext } from "../ui/dialog";
import { AuthForm, authFormTitle } from "./auth-form";
import type { AccountMode } from "./auth-model";
import { CloudVerificationPanel } from "./verification-panel";

function AuthDialog({
  initialMode,
  reason,
  resolve,
  dismiss,
}: PromptContext<AuthUser | undefined> & { initialMode: AccountMode; reason?: string }) {
  useAppLanguage();
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [verifyingUser, setVerifyingUser] = useState<AuthUser | null>(null);

  // A close button and a click outside close it too, so a mouse is never trapped in it.
  if (verifyingUser) return <DialogFrame title={`Confirm ${verifyingUser.email}`} onClose={dismiss}>
    <CloudVerificationPanel onVerified={resolve} onContinueFree={() => resolve(verifyingUser)} />
  </DialogFrame>;

  return (
    <DialogFrame title={authFormTitle(mode)} subtitle={reason} onClose={dismiss}>
      <AuthForm
        initialMode={initialMode}
        onModeChange={setMode}
        onSignedIn={(user) => user.emailVerified ? resolve(user) : setVerifyingUser(user)}
        onEscape={dismiss}
      />
    </DialogFrame>
  );
}

export interface AuthDialogRequest {
  mode?: AccountMode;
  /** What asked for it, under the title: the delayed mark says what is delayed and by how much. */
  reason?: string;
  onSignedIn?: (user: AuthUser) => void;
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
      void dialog
        .prompt<AuthUser | undefined>({
          closeOnClickOutside: true,
          content: (context: unknown) => (
            <AuthDialog
              {...(context as PromptContext<AuthUser | undefined>)}
              initialMode={request.mode ?? "login"}
              reason={request.reason}
            />
          ),
        })
        .then((user) => {
          if (user) request.onSignedIn?.(user);
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
