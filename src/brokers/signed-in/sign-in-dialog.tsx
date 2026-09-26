/**
 * The dialog that connects a signed-in broker, plus the request bridge that
 * lets the command bar, the Brokers pane and onboarding open it. Those run
 * outside the React tree or in the desktop view, which is also where the
 * browser hand-off has to happen, so the broker adapter never opens it.
 */
import { useEffect, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../../api-client";
import { SignInCodePanel } from "../../components/sign-in-code-panel";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useViewport } from "../../react/input";
import { colors } from "../../theme/colors";
import { Box, Text, TextAttributes } from "../../ui";
import { useDialog, useDialogKeyboard, type PromptContext } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { DeviceSignInDialog } from "../../plugins/builtin/cloud/device-signin-dialog";
import type { SignedInBroker } from "./client";
import { BrokerSignInController, type BrokerSignInSnapshot } from "./sign-in";

function signInStatus(snapshot: BrokerSignInSnapshot, broker: SignedInBroker): { text: string; color: string } {
  switch (snapshot.phase) {
    case "connected":
      return { text: t("Connected"), color: colors.positive };
    case "error":
      return { text: snapshot.error ?? t("Something went wrong."), color: colors.negative };
    case "waiting":
      return snapshot.error
        ? { text: t(snapshot.error), color: colors.warning }
        : { text: tf("Waiting for {broker}...", { broker: broker.name }), color: colors.textDim };
    default:
      return { text: t("Contacting Gloom..."), color: colors.textDim };
  }
}

function BrokerSignInDialog({
  resolve,
  dismiss,
  broker,
  write,
}: PromptContext<boolean> & { broker: SignedInBroker; write: boolean }) {
  useAppLanguage();
  const { height: termHeight } = useViewport();
  const controllerRef = useRef<BrokerSignInController | null>(null);
  if (!controllerRef.current) controllerRef.current = new BrokerSignInController(broker, write);
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

  // Close after a beat so "Connected" is visible; enter skips the wait.
  useEffect(() => {
    if (snapshot.phase !== "connected") return;
    const closeTimer = setTimeout(() => resolve(true), 900);
    return () => clearTimeout(closeTimer);
  }, [resolve, snapshot.phase]);

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (event.name === "enter" || event.name === "return") {
      if (snapshot.phase === "connected") resolve(true);
    } else if (isPlainKey(event, "r") && snapshot.phase !== "connected") {
      controller.start();
    } else if (event.name === "escape") {
      dismiss();
    }
  });

  const note = broker.capabilities.signupNote
    ?? (broker.capabilities.singleConnection
      ? tf("Other AI apps linked to {broker} get disconnected. Connect them to Gloom instead.", { broker: broker.name })
      : null);
  // Title, spacing, note, and footer take about eleven rows around the panel.
  const panelHeight = Math.max(4, termHeight - (note ? 12 : 10));

  return (
    <Box flexDirection="column" alignItems="center">
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {tf("Connect {broker}", { broker: broker.name })}
        </Text>
      </Box>
      <Box height={1}>
        <Text fg={colors.textDim}>{t("Open the link and enter the code there.")}</Text>
      </Box>
      <Box height={1} />
      <SignInCodePanel
        url={snapshot.connectUrl}
        code={snapshot.code}
        status={signInStatus(snapshot, broker)}
        height={panelHeight}
        shortcutScope="broker-signin:browser"
      />
      {note && (
        <>
          <Box height={1} />
          <Box height={1}>
            <Text fg={colors.textMuted}>{note}</Text>
          </Box>
        </>
      )}
      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textMuted}>{t("r for a new code · esc to cancel")}</Text>
      </Box>
    </Box>
  );
}

export interface BrokerSignInRequest {
  broker: SignedInBroker;
  /** Ask for trading as well as reading when the broker offers it. Defaults to true. */
  write?: boolean;
  resolve: (connected: boolean) => void;
}

const requestListeners = new Set<(request: BrokerSignInRequest) => void>();

/**
 * Connects a signed-in broker, signing in to Gloom first when needed.
 * Resolves true once the broker is connected, false when the user cancels or
 * no dialog host is mounted.
 */
export function requestBrokerSignIn(broker: SignedInBroker, options: { write?: boolean } = {}): Promise<boolean> {
  if (requestListeners.size === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    for (const listener of requestListeners) listener({ broker, write: options.write, resolve });
  });
}

export function BrokerSignInDialogHost() {
  const dialog = useDialog();
  const openRef = useRef(false);

  useEffect(() => {
    const listener = (request: BrokerSignInRequest) => {
      if (openRef.current) {
        request.resolve(false);
        return;
      }
      openRef.current = true;
      void (async () => {
        // The broker connection belongs to the Gloom account, so there must be one.
        if (!apiClient.isSignedIn()) {
          const user = await dialog.prompt<AuthUser | undefined>({
            size: "full",
            content: (context: unknown) => <DeviceSignInDialog {...(context as PromptContext<AuthUser | undefined>)} />,
          });
          if (!user) return false;
        }
        const connected = await dialog.prompt<boolean>({
          size: "full",
          content: (context: unknown) => (
            <BrokerSignInDialog
              {...(context as PromptContext<boolean>)}
              broker={request.broker}
              write={request.write ?? true}
            />
          ),
        });
        return connected === true;
      })()
        .then(request.resolve, () => request.resolve(false))
        .finally(() => {
          openRef.current = false;
        });
    };
    requestListeners.add(listener);
    return () => {
      requestListeners.delete(listener);
    };
  }, [dialog]);

  return null;
}
