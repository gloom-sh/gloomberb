/**
 * Mandatory sign-in for the hosted browser terminal.
 *
 * The app mounts and runs behind a dark scrim so the workspace is visible while
 * the panel is up, but nothing behind it is reachable: the panel cannot be
 * dismissed, the scrim swallows the pointer, and every app shortcut is held.
 * The gate closes by itself, because both sign-in paths install a session that
 * `usePlanAccess` observes.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { matchesKeyChord, parseKeyChord } from "../app/keybindings";
import { AuthForm, authFormTitle } from "../plugins/builtin/cloud/auth-form";
import type { AccountMode } from "../plugins/builtin/cloud/auth-model";
import {
  DeviceSignInController,
  type DeviceSignInSnapshot,
} from "../plugins/builtin/cloud/device-signin";
import { DeviceSignInPanel } from "../plugins/builtin/cloud/device-signin-dialog";
import { useShortcut, useViewport } from "../react/input";
import { useThemeColors } from "../theme/theme-context";
import { Box, Text } from "../ui";
import { isPlainKey } from "../utils/keyboard";
import { Button } from "./ui";
import { DialogFrame, modalSurfaceStyle } from "./ui/frame";

/**
 * One scope for every surface inside the gate. Scoped handlers run ahead of the
 * app's unscoped ones, and once the hold below claims the event nothing outside
 * this scope sees it.
 */
const GATE_SCOPE = "sign-in-gate";

/** Switches the email form to QR sign-in; a field has the keyboard, so it is a chord. */
const SHOW_QR_KEY = "Ctrl+G";
const SHOW_QR_CHORD = parseKeyChord(SHOW_QR_KEY)!;

/**
 * Swallows whatever the gate's own surfaces did not handle, so the workspace
 * behind the scrim never sees a keystroke. Rendered last inside the gate and
 * remounted with the view it holds: same scope, same phase, so registering
 * after the form or the QR panel gives them first refusal. It never calls
 * `preventDefault`, which on the DOM renderer would reach the real keyboard
 * event and stop the fields from taking input.
 */
function HoldAppInput() {
  useShortcut((event) => {
    event.stopPropagation();
  }, { scope: GATE_SCOPE, phase: "before", allowEditable: true });
  return null;
}

/**
 * QR device sign-in: the terminal shows a code, and a phone that already has
 * the Gloom app approves it. The controller adopts the approved session, which
 * is what dismisses the gate, so there is no completion callback here.
 */
function GateQrPanel({ height, onUseEmail }: { height: number; onUseEmail: () => void }) {
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

  useShortcut((event) => {
    if (isPlainKey(event, "escape")) {
      event.preventDefault();
      event.stopPropagation();
      onUseEmail();
      return;
    }
    if (snapshot.phase === "approved") return;
    const retry = isPlainKey(event, "r") || event.name === "enter" || event.name === "return";
    if (!retry) return;
    event.preventDefault();
    event.stopPropagation();
    controller.start();
  }, { scope: GATE_SCOPE, phase: "before", allowEditable: true });

  return <DeviceSignInPanel snapshot={snapshot} height={height} shortcutScope={GATE_SCOPE} />;
}

/** The email form, plus the chord that swaps it for QR sign-in. */
function GateEmailSignIn({
  onModeChange,
  onShowQr,
}: {
  onModeChange: (mode: AccountMode) => void;
  onShowQr: () => void;
}) {
  useShortcut((event) => {
    if (!matchesKeyChord(SHOW_QR_CHORD, event)) return;
    event.preventDefault();
    event.stopPropagation();
    onShowQr();
  }, { scope: GATE_SCOPE, phase: "before", allowEditable: true });

  return (
    <AuthForm
      initialMode="signup"
      shortcutScope={GATE_SCOPE}
      onModeChange={onModeChange}
      onSignedIn={() => {}}
      footer={(
        <Box flexDirection="row">
          <Button
            label={t("Scan with the Gloom app")}
            variant="ghost"
            shortcut={SHOW_QR_KEY}
            onPress={onShowQr}
          />
        </Box>
      )}
    />
  );
}

export function SignInGate() {
  useAppLanguage();
  const colors = useThemeColors();
  const viewport = useViewport();
  const [showQr, setShowQr] = useState(false);
  const [mode, setMode] = useState<AccountMode>("signup");

  const title = showQr ? t("Scan with the Gloom app") : authFormTitle(mode);
  const subtitle = showQr
    ? t("Approve the code from a phone that is already signed in.")
    : mode === "signup"
      ? t("Layouts, watchlists and portfolios sync to your account.")
      : null;

  return (
    <Box
      position="absolute"
      left={0}
      zIndex={9_998}
      alignItems="center"
      justifyContent="center"
      style={{
        top: 0,
        width: "100%",
        height: "100%",
        padding: 24,
        backgroundColor: `color-mix(in srgb, ${colors.bg} 82%, transparent)`,
        boxSizing: "border-box",
      }}
      data-gloom-role="sign-in-gate"
    >
      <Box flexDirection="column" style={modalSurfaceStyle(colors, { padding: 0 })}>
        <DialogFrame title={title}>
          <Box flexDirection="column" gap={1}>
            {subtitle ? <Text fg={colors.textMuted} wrapText>{subtitle}</Text> : null}
            {showQr ? (
              <>
                <GateQrPanel height={Math.max(4, viewport.height - 16)} onUseEmail={() => setShowQr(false)} />
                <Box flexDirection="row">
                  <Button
                    label={t("Use email instead")}
                    variant="ghost"
                    shortcut="Esc"
                    onPress={() => setShowQr(false)}
                  />
                </Box>
              </>
            ) : (
              <GateEmailSignIn onModeChange={setMode} onShowQr={() => setShowQr(true)} />
            )}
          </Box>
        </DialogFrame>
      </Box>
      <HoldAppInput key={showQr ? "qr" : "email"} />
    </Box>
  );
}
