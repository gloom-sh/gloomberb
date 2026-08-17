import { useEffect, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import type {
  ScannerFlowPayload,
  ScannerHiloPayload,
  ScannerPayload,
} from "../../../api-client";
import type { PaneFooterSegment } from "../../../components";
import { tf } from "../../../i18n";
import { useCloudAccessFooter } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { CLOUD_QUOTE_DELAY_MINUTES } from "../shared/plan-access";

export interface ScannerFeedState<T extends ScannerPayload> {
  payload: T | null;
  /** True once the server refused the subscription (not signed in, or not Pro). */
  denied: boolean;
  deniedReason: string | null;
}

const INITIAL_STATE = { payload: null, denied: false, deniedReason: null } as const;

function useScannerFeed<T extends ScannerPayload>(scanner: "hilo" | "flow"): ScannerFeedState<T> {
  const [state, setState] = useState<ScannerFeedState<T>>(INITIAL_STATE);

  useEffect(() => {
    setState(INITIAL_STATE);
    return apiClient.subscribeScanner(scanner, (event) => {
      setState(event.type === "denied"
        ? { payload: null, denied: true, deniedReason: event.reason }
        : { payload: event.payload as unknown as T, denied: false, deniedReason: null });
    });
  }, [scanner]);

  return state;
}

export function useHiloFeed(): ScannerFeedState<ScannerHiloPayload> {
  return useScannerFeed<ScannerHiloPayload>("hilo");
}

export function useFlowFeed(): ScannerFeedState<ScannerFlowPayload> {
  return useScannerFeed<ScannerFlowPayload>("flow");
}

/**
 * The only status a scanner pane can change between: the cloud entitlement this
 * feed arrived on, stream health while it is entitled, or the auth/entitlement
 * refusal. The delay comes from the payload, since the server moves a session
 * between the realtime and delayed instances without a remount.
 */
export function useScannerStatusFooter(
  registrationId: string,
  state: ScannerFeedState<ScannerPayload>,
  focused: boolean,
): void {
  const { segment } = useCloudAccessFooter({
    delayLabel: tf("{count}m", { count: state.payload?.delayMinutes || CLOUD_QUOTE_DELAY_MINUTES }),
    degraded: state.payload?.access === "delayed",
    focused,
    segmentId: `${registrationId}-access`,
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
    const status = state.payload?.status;
    if (!status || status === "starting") {
      return [{ id: "scanner-status", parts: [{ text: "connecting", tone: "muted" as const }] }];
    }
    if (status === "live") {
      return [{ id: "scanner-status", parts: [{ text: "live", tone: "positive" as const }] }];
    }
    if (status === "closed") {
      return [{ id: "scanner-status", parts: [{ text: "market closed", tone: "muted" as const }] }];
    }
    return [{ id: "scanner-status", parts: [{ text: "degraded", tone: "warning" as const }] }];
  }, [state.denied, state.deniedReason, state.payload?.status]);

  const info = useMemo(
    () => (segment ? [segment, ...status] : status),
    [segment, status],
  );

  usePaneStatusFooter({ registrationId, info });
}
