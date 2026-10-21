import { useCallback, useMemo, useRef, useState } from "react";
import { signedInBrokerForProfile } from "../../../brokers/signed-in/connect";
import { isSignedInBrokerProfile } from "../../../brokers/signed-in/profile";
import { requestBrokerSignIn } from "../../../brokers/signed-in/sign-in-dialog";
import type { PaneFooterSegment, PaneHint } from "../../../components/layout/pane/footer/model";
import { t, tf } from "../../../i18n";
import type { BrokerInstanceConfig } from "../../../types/config";
import { formatShortDate } from "../../../utils/datetime-format";
import { usePaneNotify, usePluginBrokerActions } from "../../runtime";

/** A broker profile Gloom cannot reach right now, so what a pane shows of it is from its last sync. */
export interface OfflineBroker {
  instance: BrokerInstanceConfig;
  brokerName: string;
  /** When the profile last synced its positions, or null when it never has. */
  syncedAt: number | null;
  /** Why it is offline, in the broker's words when it gave some. */
  reason: string;
  /**
   * False when no plugin connects it, so pressing a key could not help. For a
   * disabled profile: whether enabling it can sync it too.
   */
  reconnectable: boolean;
  /**
   * The profile is turned off. Nothing syncs or reconnects it while it is
   * (`syncBrokerInstance` refuses it); its one key enables it.
   */
  disabled?: boolean;
}

/** The key onboarding gives "Connect a broker": it reconnects an offline broker and enables a disabled one. */
const BROKER_KEY = "b";

/** `[b] enable`: one look for every pane that shows a disabled broker profile. */
export function enableBrokerHint(brokerName: string, onPress: () => void, disabled = false): PaneHint {
  return {
    id: "enable-broker",
    key: BROKER_KEY,
    label: " enable",
    title: tf("Enable {broker}", { broker: brokerName }),
    onPress,
    disabled,
  };
}

/**
 * Turns a disabled broker profile back on, then syncs it when a plugin
 * connects it, as the app syncs every enabled profile when it starts.
 */
export async function enableBrokerProfile(
  actions: Pick<ReturnType<typeof usePluginBrokerActions>, "updateBrokerInstance" | "syncBrokerInstance">,
  instanceId: string,
  { sync }: { sync: boolean },
): Promise<void> {
  await actions.updateBrokerInstance(instanceId, {}, { enabled: true });
  if (sync) await actions.syncBrokerInstance(instanceId);
}

/** `as of 14:02` today, `as of Oct 17 14:02` before. */
function formatBrokerSyncedAt(syncedAt: number, now = Date.now()): string {
  const date = new Date(syncedAt);
  const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = date.toDateString() === new Date(now).toDateString();
  return today
    ? tf("as of {time}", { time })
    : tf("as of {date} {time}", { date: formatShortDate(date, { year: false }), time });
}

export interface OfflineBrokerFooter {
  /** `as of …`, when the profile has synced. */
  asOf: PaneFooterSegment[];
  /** Why the broker is offline or disabled, or that it is reconnecting. */
  status: PaneFooterSegment[];
  hints: PaneHint[];
}

const ONLINE: OfflineBrokerFooter = { asOf: [], status: [], hints: [] };

/**
 * Footer status and key for a pane showing a broker that is offline: when its
 * positions were synced, why it is offline, and `[b] reconnect`. Reconnecting
 * does what Connect does in Brokers (a signed-in broker asks for a new
 * sign-in, any other connects), then syncs the profile so the positions are
 * current again. Nothing changes on screen until that sync lands.
 *
 * A disabled profile is never reconnected or synced: the footer says it is
 * disabled, and `[b] enable` turns it back on and syncs it. What fails is said
 * in this pane, not in the app's toasts.
 */
export function useOfflineBrokerFooter(offline: OfflineBroker | null): OfflineBrokerFooter {
  const brokerActions = usePluginBrokerActions();
  const { connectBrokerInstance, syncBrokerInstance } = brokerActions;
  const notify = usePaneNotify();
  const [working, setWorking] = useState(false);
  const runningRef = useRef(false);
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const brokerActionsRef = useRef(brokerActions);
  brokerActionsRef.current = brokerActions;

  const reconnect = useCallback(async () => {
    const target = offlineRef.current;
    if (!target || runningRef.current) return;
    if (!target.disabled && !target.reconnectable) return;
    runningRef.current = true;
    setWorking(true);
    try {
      if (target.disabled) {
        await enableBrokerProfile(brokerActionsRef.current, target.instance.id, { sync: target.reconnectable });
      } else {
        if (isSignedInBrokerProfile(target.instance)) {
          if (!await requestBrokerSignIn(signedInBrokerForProfile(target.instance, target.brokerName))) return;
        } else {
          await connectBrokerInstance(target.instance.id);
        }
        await syncBrokerInstance(target.instance.id);
      }
    } catch (error) {
      const fallback = target.disabled
        ? tf("Could not enable {broker}.", { broker: target.brokerName })
        : tf("Could not reconnect {broker}.", { broker: target.brokerName });
      notify({ type: "error", body: error instanceof Error && error.message ? error.message : fallback });
    } finally {
      runningRef.current = false;
      setWorking(false);
    }
  }, [connectBrokerInstance, notify, syncBrokerInstance]);

  return useMemo(() => {
    if (!offline) return ONLINE;
    // Dates the positions, not the quotes, so a shot that dates its quotes keeps it.
    const asOf: PaneFooterSegment[] = offline.syncedAt != null
      ? [{ id: "broker-as-of", asOf: false, parts: [{ text: formatBrokerSyncedAt(offline.syncedAt), tone: "muted" }] }]
      : [];
    const status: PaneFooterSegment[] = [working
      ? { id: "broker-status", parts: [{ text: offline.disabled ? t("Enabling…") : t("Reconnecting…"), tone: "muted" }] }
      // The broker's own words can run long: they give way to the hints behind an ellipsis.
      : { id: "broker-status", clip: true, parts: [{ text: offline.reason, tone: "warning" }] }];
    const press = () => { void reconnect(); };
    const hints: PaneHint[] = offline.disabled
      ? [enableBrokerHint(offline.brokerName, press, working)]
      : offline.reconnectable
        ? [{
            id: "reconnect-broker",
            key: BROKER_KEY,
            label: " reconnect",
            title: tf("Reconnect {broker}", { broker: offline.brokerName }),
            onPress: press,
            disabled: working,
          }]
        : [];
    return { asOf, status, hints };
  }, [offline, reconnect, working]);
}
