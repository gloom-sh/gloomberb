import { useMemo } from "react";
import { usePaneFooter, type PaneFooterSegment, type PaneHint } from "./footer";
import { useExternalLinkFooter } from "../../use-external-link-footer";
import { loadingErrorFooterInfo } from "../../data-table/table-pane";

const EMPTY_STATUS_INFO: PaneFooterSegment[] = [];

// `r` refreshes every pane, so it is global product knowledge and deliberately
// has no per-pane footer hint. Do not reintroduce one. See PR #589. Panes bind
// it with `usePaneRefreshKey`.

const STALE_SEGMENT: PaneFooterSegment = { id: "stale", parts: [{ text: "stale", tone: "warning" }] };

interface PaneStatusInfoOptions {
  loading?: boolean;
  error?: string | null;
  /** The data on screen is older than it should be; adds the shared `stale` warning after `info`. */
  stale?: boolean;
  info?: readonly PaneFooterSegment[];
}

function buildPaneStatusInfo({
  loading = false,
  error,
  stale = false,
  info = EMPTY_STATUS_INFO,
}: PaneStatusInfoOptions): PaneFooterSegment[] {
  return [...info, ...(stale ? [STALE_SEGMENT] : []), ...loadingErrorFooterInfo(loading, error)];
}

export function usePaneStatusFooter({
  registrationId,
  loading = false,
  error,
  stale = false,
  info = EMPTY_STATUS_INFO,
  hints,
  enabled = true,
}: PaneStatusInfoOptions & {
  registrationId: string;
  hints?: PaneHint[];
  enabled?: boolean;
}) {
  const statusInfo = useMemo(
    () => buildPaneStatusInfo({ loading, error, stale, info }),
    [error, info, loading, stale],
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
  stale = false,
  info = EMPTY_STATUS_INFO,
  hints,
  showOpenHint = false,
}: PaneStatusInfoOptions & {
  registrationId: string;
  focused: boolean;
  url: string | null | undefined;
  source?: string | null;
  label?: string;
  hints?: PaneHint[];
  showOpenHint?: boolean;
}) {
  const statusInfo = useMemo(
    () => buildPaneStatusInfo({ loading, error, stale, info }),
    [error, info, loading, stale],
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
