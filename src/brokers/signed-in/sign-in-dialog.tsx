/**
 * The dialog that connects a signed-in broker, plus the request bridge that
 * lets the Brokers pane and onboarding open it. Those run outside the React
 * tree or in the desktop view, which is also where the browser hand-off has to
 * happen, so the broker adapter never opens it. The Brokers pane's add flow and
 * New Portfolio's form show the same step in place, built from the pieces
 * exported here.
 */
import { useEffect, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../../api-client";
import { SignInCodePanel } from "../../components/sign-in-code-panel";
import { Button } from "../../components/ui/button";
import { DialogActions } from "../../components/ui/dialog-actions";
import { FORM_DIALOG_WIDTH, DialogFrame } from "../../components/ui/frame";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useViewport } from "../../react/input";
import { colors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { useDialog, useDialogKeyboard, type DialogApi, type PromptContext } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { wrapTextLines } from "../../utils/text-wrap";
import { DeviceSignInDialog } from "../../account/device-signin-dialog";
import type { SignedInBroker } from "./client";
import {
  BrokerSignInController,
  runBrokerSignIn,
  type BrokerSignInOptions,
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

/** What every connect surface says under its title: the browser does the rest. */
export const BROKER_CONNECT_SUBTITLE = "Continue in your browser.";

/** The key every connect surface takes for a fresh link, as the desktop shows it. */
export const BROKER_CONNECT_NEW_LINK = { key: "r", label: "new link" };

/** Under the panel: the broker's own note, or what connecting a single-connection broker does to other apps. */
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
  options: BrokerSignInOptions = {},
): { snapshot: BrokerSignInSnapshot; restart(): void; finish(): void } {
  const controllerRef = useRef<BrokerSignInController | null>(null);
  if (!controllerRef.current) controllerRef.current = new BrokerSignInController(broker, write, {}, options);
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

/**
 * Rows the dialog's own lines take around the connect view: the terminal's
 * margins, border and padding (7), title, subtitle and key line with the
 * blank rows between them, and the desktop's frame, title block and Cancel.
 */
const TERMINAL_DIALOG_ROWS = 12;
const DESKTOP_DIALOG_ROWS = 10;
/** Columns the terminal's full dialog takes from the window: margins, border and padding. */
const TERMINAL_DIALOG_INSET = 8;
/** Cells the desktop dialog's padding takes from its width. */
const DESKTOP_DIALOG_INSET = 4;

function BrokerSignInDialog({
  resolve,
  dismiss,
  broker,
  write,
  renew,
}: PromptContext<BrokerSignInOutcome> & { broker: SignedInBroker; write: boolean; renew: boolean }) {
  useAppLanguage();
  const { nativePaneChrome } = useUiCapabilities();
  const { width: termWidth, height: termHeight } = useViewport();
  // Close after a beat so "Connected" is visible; enter skips the wait. Signed
  // out closes at once, for the host to sign in to Gloom.
  const { snapshot, restart, finish } = useBrokerSignInAttempt(broker, write, resolve, { renew });

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

  const title = tf("Connect {broker}", { broker: broker.name });
  const subtitle = t(BROKER_CONNECT_SUBTITLE);

  // The desktop frames it as New Portfolio frames its connect step: as wide,
  // with Cancel at the foot and the key for a new link beside it.
  if (nativePaneChrome) {
    return (
      <Box width={FORM_DIALOG_WIDTH} maxWidth="calc(100vw - 72px)" flexDirection="column">
        <DialogFrame title={title} subtitle={subtitle} onClose={dismiss} desktopFooter={null}>
          <BrokerConnectView
            broker={broker}
            snapshot={snapshot}
            height={Math.max(4, termHeight - DESKTOP_DIALOG_ROWS)}
            width={FORM_DIALOG_WIDTH - DESKTOP_DIALOG_INSET}
          />
          <Box style={{ marginTop: 14 }}>
            <DialogActions alignEnd hints={{ keys: [BROKER_CONNECT_NEW_LINK] }}>
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
      <BrokerConnectView
        broker={broker}
        snapshot={snapshot}
        height={Math.max(4, termHeight - TERMINAL_DIALOG_ROWS)}
        width={Math.max(10, termWidth - TERMINAL_DIALOG_INSET)}
      />
      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textMuted}>{t("r for a new link · esc to cancel")}</Text>
      </Box>
    </Box>
  );
}

/**
 * On the desktop a connect's note, under the panel, is set to a reading
 * measure rather than the width of the dialog or pane. The terminal wraps it
 * to the width it has, since every row it takes is one the QR code may need.
 */
const NOTE_MEASURE = 56;

/**
 * One attempt at connecting a signed-in broker as the user sees it: the link,
 * QR code and status, with the broker's note wrapped under them. The connect
 * dialog, Add Broker's step in the Brokers pane and New Portfolio's show it.
 */
export function BrokerConnectView({
  broker,
  snapshot,
  height,
  width,
  browserKey = true,
}: {
  broker: SignedInBroker;
  snapshot: BrokerSignInSnapshot;
  /** Terminal rows for the panel and the note. */
  height: number;
  /** Terminal columns the note wraps to. */
  width: number;
  /** Whether `b` opens the link now. */
  browserKey?: boolean;
}) {
  useAppLanguage();
  const colors = useThemeColors();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const note = brokerSignInNote(broker);
  const noteLines = note ? wrapTextLines(note, Math.max(10, desktop ? Math.min(width, NOTE_MEASURE) : width)) : [];
  // The note goes under the panel, which gets the rows left.
  const noteRows = note ? 1 + noteLines.length : 0;

  return (
    <Box flexDirection="column" alignItems="center">
      <SignInCodePanel
        url={snapshot.connectUrl}
        code={snapshot.code}
        status={brokerSignInStatus(snapshot, broker)}
        height={Math.max(4, height - noteRows)}
        shortcutScope="broker-signin:browser"
        browserKey={browserKey}
      />
      {note && (desktop
        ? (
          <Box marginTop={1} maxWidth={NOTE_MEASURE}>
            <Text fg={colors.textMuted} wrapText style={{ textAlign: "center" }}>{note}</Text>
          </Box>
        )
        : (
          <>
            <Box height={1} />
            {noteLines.map((line, index) => (
              <Box key={index} height={1}>
                <Text fg={colors.textMuted}>{line}</Text>
              </Box>
            ))}
          </>
        ))}
    </Box>
  );
}

export interface BrokerSignInRequest {
  broker: SignedInBroker;
  /** Ask for trading as well as reading. Defaults to whether the broker takes orders. */
  write?: boolean;
  /** Sign in again although the broker is connected. */
  renew?: boolean;
  resolve: (connected: boolean) => void;
}

const requestListeners = new Set<(request: BrokerSignInRequest) => void>();

/**
 * Connects a signed-in broker, signing in to Gloom first when needed.
 * Resolves true once the broker is connected, false when the user cancels or
 * no dialog host is mounted. A broker that is already connected is done at
 * once unless `renew` asks for a new sign-in.
 */
export function requestBrokerSignIn(
  broker: SignedInBroker,
  options: { write?: boolean; renew?: boolean } = {},
): Promise<boolean> {
  if (requestListeners.size === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const write = options.write ?? Boolean(broker.capabilities.orders);
    for (const listener of requestListeners) listener({ broker, write, renew: options.renew, resolve });
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
        connectBroker: async (broker, write, renew) => await dialog.prompt<BrokerSignInOutcome>({
          size: "full",
          content: (context: unknown) => (
            <BrokerSignInDialog
              {...(context as PromptContext<BrokerSignInOutcome>)}
              broker={broker}
              write={write}
              renew={renew}
            />
          ),
        }) ?? "cancelled",
      }, { renew: request.renew })
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
