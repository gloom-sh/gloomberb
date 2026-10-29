import { useId, useMemo } from "react";
import { companyDataFooterSegment, usePaneFooter, type PaneFooterSegment, type PaneHint } from "./footer";
import type { CompanyFrom } from "../../../types/company-from";
import { useAppLanguage } from "../../../i18n/react";
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

/**
 * Where the company data note sits: after the warning indicator (-10) and
 * before the pane's own status (0 and the ticker quote's -1), so it leads what
 * the pane says about its data and a narrow footer cuts that status first.
 */
const COMPANY_DATA_ORDER = -5;

/**
 * A company pane on a receipt or a foreign line that shows its company's data
 * from the home line says which: `company data from 000660 KRX · as of
 * 2026-06-30`, before the pane's own status (after a warning). Nothing when
 * the data is the listing's own. Every company pane registers it here, so it
 * reads, looks and sits the same in each.
 */
export function useCompanyDataFooter(companyFrom: CompanyFrom | null | undefined, enabled = true) {
  const language = useAppLanguage();
  const segment = useMemo(() => companyDataFooterSegment(companyFrom), [
    language,
    companyFrom?.symbol,
    companyFrom?.exchange,
    companyFrom?.name,
  ]);
  // Its own registration, so a view nested in a pane (13D/G under holders) never clears the pane's.
  const id = useId();
  usePaneFooter(
    `company-data:${id}`,
    () => enabled && segment ? { order: COMPANY_DATA_ORDER, info: [segment] } : null,
    [enabled, segment],
  );
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
