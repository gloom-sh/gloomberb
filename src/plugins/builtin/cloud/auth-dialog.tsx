/**
 * Shared email/password auth dialog plus the request bridge that lets commands
 * (which run outside the React tree) open it. `AuthDialogHost` is mounted by
 * the shell for the life of the app and owns the actual dialog, mirroring the
 * QR sign-in dialog host. The form body itself lives in `auth-form`, which the
 * hosted terminal's sign-in gate reuses.
 */
import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../../../api-client";
import { DialogFrame } from "../../../components/ui/frame";
import { useAppLanguage } from "../../../i18n/react";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { AuthForm, authFormTitle } from "./auth-form";
import type { AccountMode } from "./auth-model";
import { CloudVerificationPanel } from "./verification-panel";

export function AuthDialog({
  initialMode,
  resolve,
  dismiss,
}: PromptContext<AuthUser | undefined> & { initialMode: AccountMode }) {
  useAppLanguage();
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [verifyingUser, setVerifyingUser] = useState<AuthUser | null>(null);

  if (verifyingUser) return <DialogFrame title={`Confirm ${verifyingUser.email}`}>
    <CloudVerificationPanel onVerified={resolve} onContinueFree={() => resolve(verifyingUser)} />
  </DialogFrame>;

  return (
    <DialogFrame title={authFormTitle(mode)}>
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
  onSignedIn?: (user: AuthUser) => void;
}

const authDialogListeners = new Set<(request: AuthDialogRequest) => void>();

/** Returns false when no dialog host is mounted, so callers can fall back. */
export function requestAuthDialog(request: AuthDialogRequest = {}): boolean {
  if (authDialogListeners.size === 0) return false;
  for (const listener of authDialogListeners) listener(request);
  return true;
}

export function AuthDialogHost() {
  const dialog = useDialog();
  const openRef = useRef(false);

  useEffect(() => {
    const listener = (request: AuthDialogRequest) => {
      if (openRef.current) return;
      openRef.current = true;
      void dialog
        .prompt<AuthUser | undefined>({
          closeOnClickOutside: false,
          content: (context: unknown) => (
            <AuthDialog
              {...(context as PromptContext<AuthUser | undefined>)}
              initialMode={request.mode ?? "login"}
            />
          ),
        })
        .then((user) => {
          if (user) request.onSignedIn?.(user);
        })
        .finally(() => {
          openRef.current = false;
        });
    };
    authDialogListeners.add(listener);
    return () => {
      authDialogListeners.delete(listener);
    };
  }, [dialog]);

  return null;
}
