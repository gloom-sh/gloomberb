import { useCallback, useMemo, useRef, useState } from "react";
import { signedInBrokerForProfile } from "../../../brokers/signed-in/connect";
import { isSignedInBrokerProfile } from "../../../brokers/signed-in/profile";
import { requestBrokerSignIn } from "../../../brokers/signed-in/sign-in-dialog";
import type { PaneFooterSegment, PaneHint } from "../../../components/layout/pane/footer/model";
import { t, tf } from "../../../i18n";
import type { BrokerInstanceConfig } from "../../../types/config";
import { formatShortDate } from "../../../utils/datetime-format";
import { usePluginAppActions, usePluginBrokerActions } from "../../runtime";

/** A broker profile Gloom cannot reach right now, so what a pane shows of it is from its last sync. */
export interface OfflineBroker {
  instance: BrokerInstanceConfig;
  brokerName: string;
  /** When the profile last synced its positions, or null when it never has. */
  syncedAt: number | null;
  /** Why it is offline, in the broker's words when it gave some. */
  reason: string;
  /** False when no plugin connects it, so pressing a key could not help. */
  reconnectable: boolean;
}

/** The key onboarding gives "Connect a broker". */
const RECONNECT_BROKER_KEY = "b";

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
  /** Why the broker is offline, or that it is reconnecting. */
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
 */
export function useOfflineBrokerFooter(offline: OfflineBroker | null): OfflineBrokerFooter {
  const { connectBrokerInstance, syncBrokerInstance } = usePluginBrokerActions();
  const { notify } = usePluginAppActions();
  const [reconnecting, setReconnecting] = useState(false);
  const runningRef = useRef(false);
  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  const reconnect = useCallback(async () => {
    const target = offlineRef.current;
    if (!target?.reconnectable || runningRef.current) return;
    runningRef.current = true;
    setReconnecting(true);
    try {
      if (isSignedInBrokerProfile(target.instance)) {
        if (!await requestBrokerSignIn(signedInBrokerForProfile(target.instance, target.brokerName))) return;
      } else {
        await connectBrokerInstance(target.instance.id);
      }
      await syncBrokerInstance(target.instance.id);
    } catch (error) {
      notify({
        type: "error",
        body: error instanceof Error ? error.message : tf("Could not reconnect {broker}.", { broker: target.brokerName }),
      });
    } finally {
      runningRef.current = false;
      setReconnecting(false);
    }
  }, [connectBrokerInstance, notify, syncBrokerInstance]);

  return useMemo(() => {
    if (!offline) return ONLINE;
    // Dates the positions, not the quotes, so a shot that dates its quotes keeps it.
    const asOf: PaneFooterSegment[] = offline.syncedAt != null
      ? [{ id: "broker-as-of", asOf: false, parts: [{ text: formatBrokerSyncedAt(offline.syncedAt), tone: "muted" }] }]
      : [];
    const status: PaneFooterSegment[] = [reconnecting
      ? { id: "broker-status", parts: [{ text: t("Reconnecting…"), tone: "muted" }] }
      : { id: "broker-status", parts: [{ text: offline.reason, tone: "warning" }] }];
    const hints: PaneHint[] = offline.reconnectable
      ? [{
          id: "reconnect-broker",
          key: RECONNECT_BROKER_KEY,
          label: " reconnect",
          title: tf("Reconnect {broker}", { broker: offline.brokerName }),
          onPress: () => { void reconnect(); },
          disabled: reconnecting,
        }]
      : [];
    return { asOf, status, hints };
  }, [offline, reconnect, reconnecting]);
}
