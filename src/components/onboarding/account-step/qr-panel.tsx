import { useCallback } from "react";
import type { AuthUser } from "../../../api-client";
import { Box } from "../../../ui";
import { useAppLanguage } from "../../../i18n/react";
import { useShortcut } from "../../../react/input";
import {
  DeviceSignInPanel,
  isDeviceSignInRetryKey,
  useDeviceSignIn,
} from "../../../plugins/builtin/cloud/device-signin-dialog";

/**
 * QR device sign-in inside the onboarding account step. The controller starts
 * on mount and cancels on unmount, so backing out to the chooser stops polling.
 */
export function AccountQrPanel({
  onApproved,
  height,
}: {
  onApproved: (email: string) => void;
  height: number;
}) {
  useAppLanguage();
  const advance = useCallback(
    (user: AuthUser) => onApproved(user.email?.trim() || user.username?.trim() || ""),
    [onApproved],
  );
  const { snapshot, retry } = useDeviceSignIn({ onApproved: advance });

  // The wizard's card holds every key it does not use, so the retry runs in a
  // scope of its own that registers after the card's and answers first.
  useShortcut((event) => {
    if (!isDeviceSignInRetryKey(event, snapshot)) return;
    event.preventDefault();
    event.stopPropagation();
    retry();
  }, { scope: "onboarding:qr", phase: "before" });

  return (
    <Box flexDirection="column" paddingX={2}>
      <DeviceSignInPanel snapshot={snapshot} height={height} />
    </Box>
  );
}
