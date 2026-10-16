import type { SignedInBroker } from "../../brokers/signed-in/client";
import {
  BROKER_CONNECT_NEW_LINK,
  BROKER_CONNECT_SUBTITLE,
  BrokerConnectView,
  useBrokerSignInAttempt,
} from "../../brokers/signed-in/sign-in-dialog";
import { t, tf } from "../../i18n";
import { useDialogKeyboard } from "../../ui/dialog";
import { isPlainKey } from "../../utils/keyboard";
import type { FormStep, FormStepContext } from "./model";

/**
 * Connecting a signed-in broker inside New Portfolio: the link and note the
 * connect dialog shows, in the form's own dialog. One step per attempt, so
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
    subtitle: t(BROKER_CONNECT_SUBTITLE),
    hints: [BROKER_CONNECT_NEW_LINK],
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
