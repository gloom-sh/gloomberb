import { useContext, useEffect, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import type {
  ScannerFlowPayload,
  ScannerHiloPayload,
  ScannerPayload,
} from "../../../api-client";
import type { PaneFooterSegment } from "../../../components";
import { tf } from "../../../i18n";
import { useCloudAccessFooter } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { CLOUD_QUOTE_DELAY_MINUTES, useCloudDisplayScope } from "../../../api-client/plan-access";
import { useAppVisible } from "../../../state/app/activity";
import { ScannerClientContext } from "../shared/scanner-capture";
import { delayedFooterSegment } from "../../../components/layout/pane/footer/model";
import { observationFooterSegment } from "../../../components/layout/pane/footer/freshness";
import { useSavedCopyFooter } from "../../../components/layout/pane/footer/registration";
import { deleteSavedCopy, readSavedCopy, writeSavedCopy } from "../../../data/pane-saved-copies";

export interface ScannerFeedState<T extends Pick<ScannerPayload, "status" | "access" | "delayMinutes">> {
  payload: T | null;
  /** True once the server refused the subscription (not signed in, or not Pro). */
  denied: boolean;
  deniedReason: string | null;
  savedAt?: number;
}

const INITIAL_STATE = { payload: null, denied: false, deniedReason: null } as const;

function useScannerFeed<T extends ScannerPayload>(scanner: "hilo" | "flow"): ScannerFeedState<T> & { identity: string; cacheScope: string | null } {
  const scope = useCloudDisplayScope();
  const identity = JSON.stringify([scanner, scope]);
  // A hidden app drops the subscription like every other stream; the last
  // payload stays on screen until the server resends on return.
  const appVisible = useAppVisible();
  const override = useContext(ScannerClientContext);
  const client = override ?? apiClient;
  const cacheScope = override ? null : scope;
  const key = useMemo(() => cacheScope ? { key: ["scanner-feed", scanner, cacheScope] } : null, [cacheScope, scanner]);
  const open = () => {
    const saved = key ? readSavedCopy<T>(key) : null;
    const state: ScannerFeedState<T> = saved ? { ...INITIAL_STATE, payload: saved.value, savedAt: saved.fetchedAt } : INITIAL_STATE;
    return { identity, client, state };
  };
  const [current, setState] = useState(open);
  const view = current.identity === identity && current.client === client ? current : open();
  if (view !== current) setState(view);
  const { state } = view;

  useEffect(() => {
    if (!appVisible || (!override && !scope)) return;
    let active = true;
    const unsubscribe = client.subscribeScanner(scanner, (event) => {
      if (!active) return;
      if (event.type === "denied") {
        if (key) deleteSavedCopy(key);
        setState({ identity, client, state: { ...INITIAL_STATE, denied: true, deniedReason: event.reason } });
        return;
      }
      const payload = event.payload as T;
      if (payload.status === "starting") return;
      if (key) writeSavedCopy(key, payload, Date.now(), 30_000);
      setState({ identity, client, state: { ...INITIAL_STATE, payload } });
    });
    return () => { active = false; unsubscribe(); };
  }, [appVisible, client, identity, key, override, scanner, scope]);

  useSavedCopyFooter(state.savedAt, appVisible);
  return { ...state, identity, cacheScope };
}

export function useHiloFeed(): ScannerFeedState<ScannerHiloPayload> {
  return useScannerFeed<ScannerHiloPayload>("hilo");
}

export function useFlowFeed() {
  return useScannerFeed<ScannerFlowPayload>("flow");
}

/**
 * The only status a scanner pane can change between: the cloud entitlement this
 * feed arrived on, stream health while it is entitled, or the auth/entitlement
 * refusal. The delay comes from the payload, since the server moves a session
 * between the realtime and delayed instances without a remount. `closed` is the
 * exchange calendar's word that the US market is shut, said before the feed
 * answers and whatever it says.
 */
export function useScannerStatusFooter(
  registrationId: string,
  state: ScannerFeedState<Pick<ScannerPayload, "status" | "access" | "delayMinutes"> & { asOf?: number | null }>,
  focused: boolean,
  extra: PaneFooterSegment | null = null,
  closed = false,
): void {
  const delayed = state.payload?.access === "delayed";
  const { hint: upgradeHint, segment } = useCloudAccessFooter({
    delayLabel: tf("{count}m", { count: state.payload?.delayMinutes || CLOUD_QUOTE_DELAY_MINUTES }),
    degraded: delayed,
    showDelayLabel: true,
    focused,
    segmentId: `${registrationId}-access`,
    placement: `${registrationId}-footer`,
    shortcutScope: `${registrationId}:upgrade`,
  });

  const status = useMemo<PaneFooterSegment[]>(() => {
    if (state.denied) {
      return [{
        id: "scanner-status",
        parts: [{
          text: state.deniedReason === "pro_required" ? "pro required" : "sign in required",
          tone: "warning" as const,
        }],
      }];
    }
    const status = closed ? "closed" : state.payload?.status;
    // The feed connects in the background; nothing to report until it answers.
    if (!status || status === "starting" || state.savedAt != null && !closed) return [];
    if (status === "live") {
      return delayed ? [] : [{ id: "scanner-status", parts: [{ text: "live", tone: "positive" as const }] }];
    }
    if (status === "closed") {
      return [{ id: "scanner-status", parts: [{ text: "market closed", tone: "muted" as const }] }];
    }
    return [{ id: "scanner-status", parts: [{ text: "degraded", tone: "warning" as const }] }];
  }, [closed, delayed, state.denied, state.deniedReason, state.payload?.status, state.savedAt]);

  // The upgrade segment carries the delay for free accounts; a delayed feed reaching Pro still says so.
  const delayMinutes = delayed ? state.payload?.delayMinutes || CLOUD_QUOTE_DELAY_MINUTES : null;
  const asOf = state.payload?.status !== "starting" ? state.payload?.asOf : null;
  const info = useMemo<PaneFooterSegment[]>(
    () => {
      const delay = delayMinutes != null && !upgradeHint ? delayedFooterSegment({
          id: "scanner-delay",
          detail: tf("{delay} delayed", { delay: tf("{count}m", { count: delayMinutes }) }),
          delay: tf("{count}m", { count: delayMinutes }),
          showLabel: true,
        }) : null;
      const observed = observationFooterSegment(asOf);
      return [segment, delay, observed, ...status, extra].filter((item): item is PaneFooterSegment => item != null);
    },
    [asOf, delayMinutes, extra, segment, status, upgradeHint],
  );

  usePaneStatusFooter({ registrationId, info, hints: upgradeHint ? [upgradeHint] : undefined });
}
