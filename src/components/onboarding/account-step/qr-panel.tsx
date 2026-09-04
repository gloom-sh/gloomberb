import { useEffect, useRef, useState } from "react";
import { Box } from "../../../ui";
import { useAppLanguage } from "../../../i18n/react";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import {
  DeviceSignInController,
  type DeviceSignInSnapshot,
} from "../../../plugins/builtin/cloud/device-signin";
import { DeviceSignInPanel } from "../../../plugins/builtin/cloud/device-signin-dialog";

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
  const controllerRef = useRef<DeviceSignInController | null>(null);
  if (!controllerRef.current) controllerRef.current = new DeviceSignInController();
  const controller = controllerRef.current;
  const [snapshot, setSnapshot] = useState<DeviceSignInSnapshot>(controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    controller.start();
    return () => {
      unsubscribe();
      controller.cancel();
    };
  }, [controller]);

  // The wizard's global handler ignores enter while this panel is open, so a
  // denial can be retried here without also advancing the step.
  useShortcut((event) => {
    if ((event.name === "enter" || event.name === "return") && snapshot.phase === "denied") {
      controller.start();
    } else if (isPlainKey(event, "r") && snapshot.phase !== "approved") {
      controller.start();
    }
  });

  useEffect(() => {
    if (snapshot.phase !== "approved" || !snapshot.user) return;
    const email = snapshot.user.email?.trim() || snapshot.user.username?.trim() || "";
    const advanceTimer = setTimeout(() => onApproved(email), 1_200);
    return () => clearTimeout(advanceTimer);
  }, [onApproved, snapshot.phase, snapshot.user]);

  return (
    <Box flexDirection="column" paddingX={2}>
      <DeviceSignInPanel snapshot={snapshot} height={height} />
    </Box>
  );
}
