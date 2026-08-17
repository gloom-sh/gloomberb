/**
 * Full-screen QR sign-in dialog plus the request bridge that lets the command
 * bar open it. Commands run outside the React tree, so `requestDeviceSignInDialog`
 * hands the request to `DeviceSignInDialogHost`, which the shell mounts for the
 * life of the app and which owns the actual dialog.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { useViewport } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes, useUiHost } from "../../../ui";
import { renderAsciiText } from "../../../ui/ascii-font";
import { useDialog, useDialogKeyboard, type PromptContext } from "../../../ui/dialog";
import { renderQrLines, renderQrSvgDataUri } from "../../../ui/qr";
import { isPlainKey } from "../../../utils/keyboard";
import { DeviceSignInController, type DeviceSignInSnapshot } from "./device-signin";

// Phone cameras need dark-on-light no matter what the terminal theme is.
const QR_FG = "#000000";
const QR_BG = "#ffffff";

export function deviceSignInStatus(snapshot: DeviceSignInSnapshot): { text: string; color: string } {
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

/**
 * QR code, human-readable code, verification URL, and live status. Shared by
 * the sign-in dialog and the onboarding account step. Degrades by height: the
 * QR needs its full module grid, so short terminals drop decoration first and
 * finally fall back to the code plus URL, which the mobile app also accepts.
 */
export function DeviceSignInPanel({
  snapshot,
  height,
}: {
  snapshot: DeviceSignInSnapshot;
  /** Rows available to this panel; drives the degradation tiers. */
  height: number;
}) {
  useAppLanguage();
  const desktop = useUiHost().kind === "desktop-web";
  // Cell lines still drive layout on desktop: they give the code its row/column
  // footprint, but the pixels come from the SVG below.
  const qrLines = useMemo(
    () => (snapshot.verificationUri ? renderQrLines(snapshot.verificationUri) : []),
    [snapshot.verificationUri],
  );
  const qrImage = useMemo(
    () => (desktop && snapshot.verificationUri ? renderQrSvgDataUri(snapshot.verificationUri) : undefined),
    [desktop, snapshot.verificationUri],
  );
  const status = deviceSignInStatus(snapshot);

  // Minimal QR layout: the code grid, one code row, and the status row.
  const showQr = qrLines.length > 0 && height >= qrLines.length + 2;
  const spacious = showQr && height >= qrLines.length + 8;
  const showUrl = !!snapshot.verificationUri && (!showQr || height >= qrLines.length + 4);

  return (
    <Box flexDirection="column" alignItems="center">
      {showQr && (qrImage
        ? (
          <Box
            width={qrLines[0]?.length ?? 0}
            height={qrLines.length}
            style={{
              backgroundImage: qrImage,
              backgroundColor: QR_BG,
              backgroundSize: "contain",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }}
          />
        )
        : (
          <Box flexDirection="column" height={qrLines.length}>
            {qrLines.map((line, index) => (
              <Box key={index} height={1}>
                <Text fg={QR_FG} bg={QR_BG}>{line}</Text>
              </Box>
            ))}
          </Box>
        ))}
      {!showQr && snapshot.verificationUri && (
        <Box height={1}>
          <Text fg={colors.textDim}>{t("Terminal is too short to draw the QR code.")}</Text>
        </Box>
      )}
      {snapshot.userCode && (
        <>
          {spacious && <Box height={1} />}
          {spacious
            ? (
              <Box flexDirection="column" height={2}>
                {renderAsciiText(snapshot.userCode, "tiny").map((line, index) => (
                  <Box key={index} height={1}>
                    <Text fg={colors.textBright}>{line}</Text>
                  </Box>
                ))}
              </Box>
            )
            : (
              <Box height={1}>
                <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{snapshot.userCode}</Text>
              </Box>
            )}
        </>
      )}
      {showUrl && (
        <>
          {spacious && <Box height={1} />}
          <Box height={1}>
            <Text fg={colors.textMuted}>
              {tf("No app? {url}", { url: snapshot.verificationUri ?? "" })}
            </Text>
          </Box>
        </>
      )}
      {spacious && <Box height={1} />}
      <Box height={1}>
        <Text fg={status.color}>{status.text}</Text>
      </Box>
    </Box>
  );
}

export function DeviceSignInDialog({ resolve, dismiss }: PromptContext<AuthUser | undefined>) {
  useAppLanguage();
  const { height: termHeight } = useViewport();
  const controllerRef = useRef<DeviceSignInController | null>(null);
  if (!controllerRef.current) controllerRef.current = new DeviceSignInController();
  const controller = controllerRef.current;
  const [snapshot, setSnapshot] = useState(controller.getSnapshot());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    controller.start();
    return () => {
      unsubscribe();
      controller.cancel();
    };
  }, [controller]);

  // Close on approval after a beat so the confirmation is visible; enter skips the wait.
  useEffect(() => {
    if (snapshot.phase !== "approved" || !snapshot.user) return;
    const closeTimer = setTimeout(() => resolve(snapshot.user ?? undefined), 1_200);
    return () => clearTimeout(closeTimer);
  }, [resolve, snapshot.phase, snapshot.user]);

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (event.name === "enter" || event.name === "return") {
      if (snapshot.phase === "approved") {
        resolve(snapshot.user ?? undefined);
      } else if (snapshot.phase === "denied") {
        controller.start();
      }
    } else if (isPlainKey(event, "r") && snapshot.phase !== "approved") {
      controller.start();
    } else if (event.name === "escape") {
      dismiss();
    }
  });

  return (
    <Box flexDirection="column" alignItems="center">
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {t("Scan with the Gloomberb mobile app to sign in")}
        </Text>
      </Box>
      <Box height={1} />
      {/* Border, padding, title, and footer take about ten rows around the panel. */}
      <DeviceSignInPanel snapshot={snapshot} height={Math.max(4, termHeight - 10)} />
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
