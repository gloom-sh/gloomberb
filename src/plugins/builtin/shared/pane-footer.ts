import { useMemo } from "react";
import {
  useExternalLinkFooter,
  usePaneFooter,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../components";

const EMPTY_STATUS_INFO: PaneFooterSegment[] = [];

// `r` refreshes every pane, so it is global product knowledge and deliberately
// has no per-pane footer hint. Do not reintroduce one. See PR #589.

function buildPaneStatusInfo({
  loading = false,
  error,
  info = EMPTY_STATUS_INFO,
}: {
  loading?: boolean;
  error?: string | null;
  info?: readonly PaneFooterSegment[];
}): PaneFooterSegment[] {
  return [
    ...info,
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
  ];
}

export function usePaneStatusFooter({
  registrationId,
  loading = false,
  error,
  info = EMPTY_STATUS_INFO,
  hints,
  enabled = true,
}: {
  registrationId: string;
  loading?: boolean;
  error?: string | null;
  info?: readonly PaneFooterSegment[];
  hints?: PaneHint[];
  enabled?: boolean;
}) {
  const statusInfo = useMemo(
    () => buildPaneStatusInfo({ loading, error, info }),
    [error, info, loading],
  );
  usePaneFooter(
    registrationId,
    () => enabled && (statusInfo.length > 0 || (hints?.length ?? 0) > 0)
      ? { info: statusInfo, hints }
      : null,
    [enabled, hints, registrationId, statusInfo],
  );
}

export function usePaneStatusLinkFooter({
  registrationId,
  focused,
  url,
  source,
  label,
  loading = false,
  error,
  info = EMPTY_STATUS_INFO,
  hints,
  showOpenHint = false,
}: {
  registrationId: string;
  focused: boolean;
  url: string | null | undefined;
  source?: string | null;
  label?: string;
  loading?: boolean;
  error?: string | null;
  info?: readonly PaneFooterSegment[];
  hints?: PaneHint[];
  showOpenHint?: boolean;
}) {
  const statusInfo = useMemo(
    () => buildPaneStatusInfo({ loading, error, info }),
    [error, info, loading],
  );
  return useExternalLinkFooter({
    registrationId,
    focused,
    url,
    source,
    label,
    info: statusInfo,
    hints,
    showHint: showOpenHint,
  });
}
