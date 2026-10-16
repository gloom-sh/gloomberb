/**
 * QR sign-in UI: the hook and panel every QR surface shares, the full-screen
 * dialog, and the request bridge that lets the command bar open it. Commands
 * run outside the React tree, so `requestDeviceSignInDialog` hands the request
 * to `DeviceSignInDialogHost`, which the shell mounts for the life of the app
 * and which owns the actual dialog.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "../api-client";
import { t, tf } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { useViewport } from "../react/input";
import { colors } from "../theme/colors";
import { Box, Text, TextAttributes, useUiCapabilities } from "../ui";
import { Button } from "../components/ui/button";
import { DialogActions } from "../components/ui/dialog-actions";
import { FORM_DIALOG_WIDTH, DialogFrame } from "../components/ui/frame";
import { SignInCodePanel } from "../components/sign-in-code-panel";
import { useDialog, useDialogKeyboard, type PromptContext } from "../ui/dialog";
import { isPlainKey, type KeyboardModifierEventLike } from "../utils/keyboard";
import { DeviceSignInController, type DeviceSignInSnapshot } from "./device-signin";

/** How long the approval stays on screen before `onApproved` moves on. */
const APPROVED_HOLD_MS = 1_200;

/**
 * Runs one device sign-in for the life of the calling component: it starts on
 * mount and cancels on unmount, so leaving the view stops polling.
 */
export function useDeviceSignIn({ onApproved }: { onApproved?: (user: AuthUser) => void } = {}): {
  snapshot: DeviceSignInSnapshot;
  retry: () => void;
} {
  const [controller] = useState(() => new DeviceSignInController());
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    controller.start();
    return () => {
      unsubscribe();
      controller.cancel();
    };
  }, [controller]);

  useEffect(() => {
    const user = snapshot.phase === "approved" ? snapshot.user : null;
    if (!onApproved || !user) return;
    const timer = setTimeout(() => onApproved(user), APPROVED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [onApproved, snapshot.phase, snapshot.user]);

  const retry = useCallback(() => controller.start(), [controller]);
  return { snapshot, retry };
}

/** `r` asks for a fresh code until the sign-in is approved; enter does after a denial. */
export function isDeviceSignInRetryKey(event: KeyboardModifierEventLike, snapshot: DeviceSignInSnapshot): boolean {
  return (isPlainKey(event, "r") && snapshot.phase !== "approved")
    || (isPlainKey(event, "enter", "return") && snapshot.phase === "denied");
}

function deviceSignInStatus(snapshot: DeviceSignInSnapshot): { text: string; color: string } {
  switch (snapshot.phase) {
    case "approved": {
      const email = snapshot.user?.email?.trim() || snapshot.user?.username?.trim() || "";
      return { text: tf("Approved as {email}", { email }), color: colors.positive };
    }
    case "denied":
      return { text: t("Denied. Press enter to request a new code."), color: colors.negative };
    case "error":
      return { text: t("Can't reach Gloomberb Cloud. Retrying..."), color: colors.warning };
    case "waiting":
      return snapshot.error
        ? { text: t("Connection problem, retrying..."), color: colors.warning }
        : { text: t("Waiting for approval..."), color: colors.textDim };
    default:
      return { text: t("Contacting Gloomberb Cloud..."), color: colors.textDim };
  }
}

/** The device sign-in's code and link in the shared browser hand-off panel. */
export function DeviceSignInPanel({
  snapshot,
  height,
  shortcutScope = "device-signin:browser",
}: {
  snapshot: DeviceSignInSnapshot;
  /** Rows available to this panel; drives the degradation tiers. */
  height: number;
  /** Scope for the browser key; see `SignInCodePanel`. */
  shortcutScope?: string;
}) {
  return (
    <SignInCodePanel
      url={snapshot.verificationUri}
      code={snapshot.userCode}
      status={deviceSignInStatus(snapshot)}
      height={height}
      shortcutScope={shortcutScope}
    />
  );
}

/**
 * Rows the dialog's own lines take around the panel: the terminal's margins,
 * border and padding (7), title, subtitle and key line with the blank rows
 * between them, and the desktop's frame, title block and Cancel.
 */
const TERMINAL_DIALOG_ROWS = 12;
const DESKTOP_DIALOG_ROWS = 10;

export function DeviceSignInDialog({ resolve, dismiss }: PromptContext<AuthUser | undefined>) {
  useAppLanguage();
  const { nativePaneChrome } = useUiCapabilities();
  const { height: termHeight } = useViewport();
  // Closes on approval after a beat so the confirmation is visible; enter skips the wait.
  const { snapshot, retry } = useDeviceSignIn({ onApproved: resolve });

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (isDeviceSignInRetryKey(event, snapshot)) {
      retry();
    } else if (event.name === "enter" || event.name === "return") {
      if (snapshot.phase === "approved") resolve(snapshot.user ?? undefined);
    } else if (event.name === "escape") {
      dismiss();
    }
  });

  const title = t("Sign in to Gloom");
  const subtitle = t("Continue in your browser or scan the code.");

  // Framed as the broker connect dialog is: as wide, Cancel and the key beside it.
  if (nativePaneChrome) {
    return (
      <Box width={FORM_DIALOG_WIDTH} maxWidth="calc(100vw - 72px)" flexDirection="column">
        <DialogFrame title={title} subtitle={subtitle} onClose={dismiss} desktopFooter={null}>
          <DeviceSignInPanel snapshot={snapshot} height={Math.max(4, termHeight - DESKTOP_DIALOG_ROWS)} />
          <Box style={{ marginTop: 14 }}>
            <DialogActions alignEnd hints={{ keys: [{ key: "r", label: "new code" }] }}>
              <Button label="Cancel" variant="secondary" desktopShortcut="Esc" onPress={dismiss} />
            </DialogActions>
          </Box>
        </DialogFrame>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      <Box height={1}>
        <Text fg={colors.textDim}>{subtitle}</Text>
      </Box>
      <Box height={1} />
      <DeviceSignInPanel snapshot={snapshot} height={Math.max(4, termHeight - TERMINAL_DIALOG_ROWS)} />
      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textMuted}>{t("r to refresh the code · esc to cancel")}</Text>
      </Box>
    </Box>
  );
}

export interface DeviceSignInDialogRequest {
  onSignedIn?: (user: AuthUser) => void;
}

const dialogRequestListeners = new Set<(request: DeviceSignInDialogRequest) => void>();

/** Returns false when no dialog host is mounted, so callers can surface an error. */
export function requestDeviceSignInDialog(request: DeviceSignInDialogRequest = {}): boolean {
  if (dialogRequestListeners.size === 0) return false;
  for (const listener of dialogRequestListeners) listener(request);
  return true;
}

export function DeviceSignInDialogHost() {
  const dialog = useDialog();
  const openRef = useRef(false);

  useEffect(() => {
    const listener = (request: DeviceSignInDialogRequest) => {
      if (openRef.current) return;
      openRef.current = true;
      void dialog
        .prompt<AuthUser | undefined>({
          size: "full",
          content: (context: unknown) => (
            <DeviceSignInDialog {...(context as PromptContext<AuthUser | undefined>)} />
          ),
        })
        .then((signedInUser) => {
          if (signedInUser) request.onSignedIn?.(signedInUser);
        })
        .finally(() => {
          openRef.current = false;
        });
    };
    dialogRequestListeners.add(listener);
    return () => {
      dialogRequestListeners.delete(listener);
    };
  }, [dialog]);

  return null;
}
