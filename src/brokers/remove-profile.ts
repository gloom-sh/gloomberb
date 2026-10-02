/**
 * Removing a broker profile, from the Brokers pane or the command bar. A
 * signed-in profile's connection belongs to the Gloom account, so it is
 * disconnected there too, as far as Gloom answers: the profile leaves this
 * device either way, and the message says what the account kept.
 */
import type { ConfirmModalOptions } from "../components/form-modal";
import { t, tf } from "../i18n";
import type { BrokerInstanceConfig } from "../types/config";
import { disconnectSignedInProfile, signedInBrokerForProfile } from "./signed-in/connect";
import { isSignedInBrokerProfile } from "./signed-in/profile";

/**
 * The confirm before `onConfirm` removes `instance`. `brokerName` names the
 * broker when the connector list does not.
 */
export function brokerProfileRemovalConfirm(
  instance: BrokerInstanceConfig,
  brokerName: string,
  onConfirm: () => Promise<void>,
): ConfirmModalOptions {
  const signedIn = isSignedInBrokerProfile(instance) ? signedInBrokerForProfile(instance, brokerName) : null;
  return {
    confirmId: "remove-broker-profile",
    title: "Disconnect broker?",
    body: [
      tf("Remove \"{label}\" and imported broker data?", { label: instance.label }),
      t("Broker-managed portfolios, positions, and contracts will be removed."),
      ...(signedIn
        ? [tf("This also disconnects {broker} from your other devices and agents.", { broker: signedIn.name })]
        : []),
    ],
    confirmLabel: "Disconnect",
    tone: "danger",
    onConfirm,
  };
}

export interface BrokerProfileRemoval {
  message: string;
  /** The Gloom account still holds the broker, so its other devices and agents keep it. */
  accountKept: boolean;
}

export async function removeBrokerProfile(
  instance: BrokerInstanceConfig,
  brokerName: string,
  removeBrokerInstance: (instanceId: string) => Promise<void>,
): Promise<BrokerProfileRemoval> {
  const account = await disconnectSignedInProfile(instance);
  await removeBrokerInstance(instance.id);
  const label = instance.label;
  if (!account.stillConnected) return { message: tf("Removed {label}.", { label }), accountKept: false };
  const broker = signedInBrokerForProfile(instance, brokerName).name;
  return {
    accountKept: true,
    message: account.signedOut
      ? tf("Removed {label}. {broker} is still connected to your Gloom account. Sign in to Gloom to disconnect {broker} from your account.", { label, broker })
      : tf("Removed {label}. {broker} is still connected to your Gloom account.", { label, broker }),
  };
}
