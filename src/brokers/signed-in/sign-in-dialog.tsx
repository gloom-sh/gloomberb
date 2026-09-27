/**
 * The dialog that connects a signed-in broker, plus the request bridge that
 * lets the Brokers pane and onboarding open it. Those run outside the React
 * tree or in the desktop view, which is also where the browser hand-off has to
 * happen, so the broker adapter never opens it. Add Broker and New Portfolio
 * show the same step inside their form, built from the pieces exported here.
 */
import { useEffect, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../../api-client";
import { SignInCodePanel } from "../../components/sign-in-code-panel";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useViewport } from "../../react/input";
import { colors } from "../../theme/colors";
import { Box, Text, TextAttributes } from "../../ui";
import { useDialog, useDialogKeyboard, type DialogApi, type PromptContext } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { DeviceSignInDialog } from "../../plugins/builtin/cloud/device-signin-dialog";
import type { SignedInBroker } from "./client";
import {
  BrokerSignInController,
  runBrokerSignIn,
  type BrokerSignInOutcome,
  type BrokerSignInSnapshot,
} from "./sign-in";

export function brokerSignInStatus(snapshot: BrokerSignInSnapshot, broker: SignedInBroker): { text: string; color: string } {
  switch (snapshot.phase) {
    case "connected":
      return { text: t("Connected"), color: colors.positive };
    case "error":
    case "signed-out":
      return { text: snapshot.error ?? t("Something went wrong."), color: colors.negative };
    case "waiting":
      return snapshot.error
        ? { text: t(snapshot.error), color: colors.warning }
        : { text: tf("Waiting for {broker}...", { broker: broker.name }), color: colors.textDim };
    default:
      return { text: t("Contacting Gloom..."), color: colors.textDim };
  }
}

/** Under the code: the broker's own note, or what connecting a single-connection broker does to other apps. */
export function brokerSignInNote(broker: SignedInBroker): string | null {
  return broker.capabilities.signupNote
    ?? (broker.capabilities.singleConnection
      ? tf("Other AI apps linked to {broker} get disconnected. Connect them to Gloom instead.", { broker: broker.name })
      : null);
}

/**
 * One attempt at connecting `broker`, with a controller of its own: started on
 * mount, cancelled on unmount. A session Gloom refused ends it at once as
 * "signed-out", for a new Gloom sign-in and a fresh attempt; "connected" waits
 * a beat so it is seen, and `finish` skips the wait.
 */
export function useBrokerSignInAttempt(
  broker: SignedInBroker,
  write: boolean,
  onOutcome: (outcome: "connected" | "signed-out") => void,
): { snapshot: BrokerSignInSnapshot; restart(): void; finish(): void } {
  const controllerRef = useRef<BrokerSignInController | null>(null);
  if (!controllerRef.current) controllerRef.current = new BrokerSignInController(broker, write);
  const controller = controllerRef.current;
  const [snapshot, setSnapshot] = useState(controller.getSnapshot());
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;

  useEffect(() => {
    const unsubscribe = controller.subscribe(setSnapshot);
    controller.start();
    return () => {
      unsubscribe();
      controller.cancel();
    };
  }, [controller]);

  useEffect(() => {
    if (snapshot.phase === "signed-out") {
      onOutcomeRef.current("signed-out");
      return;
    }
    if (snapshot.phase !== "connected") return;
    const closeTimer = setTimeout(() => onOutcomeRef.current("connected"), 900);
    return () => clearTimeout(closeTimer);
  }, [snapshot.phase]);

  return {
    snapshot,
    restart: () => {
      if (snapshot.phase !== "connected") controller.start();
    },
    finish: () => {
      if (snapshot.phase === "connected") onOutcomeRef.current("connected");
    },
  };
}

/** Gloom's device sign-in, stacked over whatever asked for it. True once signed in. */
export async function promptGloomSignIn(dialog: DialogApi): Promise<boolean> {
  return !!await dialog.prompt<AuthUser | undefined>({
    size: "full",
    content: (context: unknown) => <DeviceSignInDialog {...(context as PromptContext<AuthUser | undefined>)} />,
  });
}

function BrokerSignInDialog({
  resolve,
  dismiss,
  broker,
  write,
}: PromptContext<BrokerSignInOutcome> & { broker: SignedInBroker; write: boolean }) {
  useAppLanguage();
  const { height: termHeight } = useViewport();
  // Close after a beat so "Connected" is visible; enter skips the wait. Signed
  // out closes at once, for the host to sign in to Gloom.
  const { snapshot, restart, finish } = useBrokerSignInAttempt(broker, write, resolve);

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (event.name === "enter" || event.name === "return") {
      finish();
    } else if (isPlainKey(event, "r")) {
      restart();
    } else if (event.name === "escape") {
      dismiss();
    }
  });

  const note = brokerSignInNote(broker);
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
        status={brokerSignInStatus(snapshot, broker)}
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
  /** Ask for trading as well as reading. Defaults to whether the broker takes orders. */
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
    const write = options.write ?? Boolean(broker.capabilities.orders);
    for (const listener of requestListeners) listener({ broker, write, resolve });
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
      // The broker connection belongs to the Gloom account, so there must be one.
      void runBrokerSignIn(request.broker, request.write, {
        isSignedIn: () => apiClient.isSignedIn(),
        signInToGloom: () => promptGloomSignIn(dialog),
        connectBroker: async (broker, write) => await dialog.prompt<BrokerSignInOutcome>({
          size: "full",
          content: (context: unknown) => (
            <BrokerSignInDialog {...(context as PromptContext<BrokerSignInOutcome>)} broker={broker} write={write} />
          ),
        }) ?? "cancelled",
      })
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
