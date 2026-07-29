import { useMemo } from "react";
import {
  useExternalLinkFooter,
  usePaneFooter,
  type PaneFooterSegment,
} from "../../../components";

const EMPTY_STATUS_INFO: PaneFooterSegment[] = [];

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
  enabled = true,
}: {
  registrationId: string;
  loading?: boolean;
  error?: string | null;
  info?: readonly PaneFooterSegment[];
  enabled?: boolean;
}) {
  const statusInfo = useMemo(
    () => buildPaneStatusInfo({ loading, error, info }),
    [error, info, loading],
  );
  usePaneFooter(
    registrationId,
    () => enabled && statusInfo.length > 0 ? { info: statusInfo } : null,
    [enabled, registrationId, statusInfo],
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
}: {
  registrationId: string;
  focused: boolean;
  url: string | null | undefined;
  source?: string | null;
  label?: string;
  loading?: boolean;
  error?: string | null;
  info?: readonly PaneFooterSegment[];
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
    showHint: false,
  });
}
