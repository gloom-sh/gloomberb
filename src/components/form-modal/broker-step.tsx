import type { SignedInBroker } from "../../brokers/signed-in/client";
import type { BrokerSignInSnapshot } from "../../brokers/signed-in/sign-in";
import {
  brokerSignInNote,
  brokerSignInStatus,
  useBrokerSignInAttempt,
} from "../../brokers/signed-in/sign-in-dialog";
import { t, tf } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../ui";
import { useDialogKeyboard } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import { wrapTextLines } from "../../utils/text-wrap";
import { SignInCodePanel } from "../sign-in-code-panel";
import type { FormStep, FormStepContext } from "./model";

/**
 * Connecting a signed-in broker inside New Portfolio: the link, code and note
 * the connect dialog shows, in the form's own dialog. One step per attempt, so
 * the attempt after a new Gloom sign-in starts a controller of its own rather
 * than reading the refusal the last one ended on.
 */
export function brokerConnectStep(
  broker: SignedInBroker,
  write: boolean,
  attempt: number,
  onOutcome: (outcome: "connected" | "signed-out") => void,
): FormStep {
  return {
    kind: "custom",
    id: `broker-connect:${attempt}`,
    title: tf("Connect {broker}", { broker: broker.name }),
    subtitle: t("Open the link and enter the code there."),
    render: (context) => <BrokerConnectStep {...context} broker={broker} write={write} onOutcome={onOutcome} />,
  };
}

function BrokerConnectStep({
  broker,
  write,
  bodyRows,
  contentWidth,
  onOutcome,
}: FormStepContext & {
  broker: SignedInBroker;
  write: boolean;
  onOutcome: (outcome: "connected" | "signed-out") => void;
}) {
  const { snapshot, restart, finish } = useBrokerSignInAttempt(broker, write, onOutcome);

  // Nothing to type into, so every key is the step's, but Esc: the host
  // takes that one and closes the form, which cancels the attempt.
  useDialogKeyboard((event) => {
    if (event.name === "escape") return;
    event.stopPropagation();
    if ((event.name === "return" || event.name === "enter") && snapshot.phase === "connected") {
      event.preventDefault();
      finish();
    } else if (isPlainKey(event, "r") && snapshot.phase !== "connected") {
      event.preventDefault();
      restart();
    }
  }, { allowEditable: true });

  return <BrokerConnectView broker={broker} snapshot={snapshot} height={bodyRows} width={contentWidth} />;
}

/**
 * One attempt at connecting a signed-in broker as the user sees it: the link,
 * QR code, code and status, with the broker's note wrapped under them. Add
 * Broker's step in the Brokers pane and New Portfolio's in the form show it.
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
  // The note wraps under the panel, which gets the rows left.
  const noteRows = note ? 1 + wrapTextLines(note, width).length : 0;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" alignItems="center">
        <SignInCodePanel
          url={snapshot.connectUrl}
          code={snapshot.code}
          status={brokerSignInStatus(snapshot, broker)}
          height={Math.max(4, height - noteRows)}
          shortcutScope="broker-signin:browser"
          browserKey={browserKey}
        />
      </Box>
      {note && (desktop
        ? <Text fg={colors.textMuted} wrapText style={{ marginTop: 12 }}>{note}</Text>
        : (
          <>
            <Box height={1} />
            <Text fg={colors.textMuted} wrapText>{note}</Text>
          </>
        ))}
    </Box>
  );
}
