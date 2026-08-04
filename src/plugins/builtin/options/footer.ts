import { useMemo } from "react";
import type { PaneFooterSegment } from "../../../components";
import { t, tf } from "../../../i18n";
import type { OptionsChain } from "../../../types/financials";
import { useCloudAccessFooter } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { CLOUD_QUOTE_DELAY_MINUTES } from "../shared/plan-access";
import type { OptionQuoteCoverage, OptionQuoteCoverageStatus } from "./live-quotes";

export interface OptionsCoverageState {
  text: string;
  tone: "muted" | "positive" | "warning";
}

/** Stream coverage the pane reports once the account is entitled to real-time options. */
export function resolveOptionsCoverageState(status: OptionQuoteCoverageStatus): OptionsCoverageState {
  if (status === "live") return { text: t("real-time options"), tone: "positive" };
  if (status === "mixed") return { text: t("mixed real-time and delayed options"), tone: "warning" };
  if (status === "connecting") return { text: t("connecting real-time options"), tone: "muted" };
  return { text: t("options delayed fallback"), tone: "warning" };
}

export function resolveOptionsDelayLabel(chain: OptionsChain | null | undefined): string {
  const delayMinutes = chain?.delayMinutes && chain.delayMinutes > 0
    ? chain.delayMinutes
    : CLOUD_QUOTE_DELAY_MINUTES;
  return tf("{count}m", { count: delayMinutes });
}

export function useOptionsAccessFooter({
  chain,
  error,
  focused,
  loading,
  quoteCoverage,
}: {
  chain: OptionsChain | null | undefined;
  error?: string | null;
  focused: boolean;
  loading?: boolean;
  quoteCoverage: Pick<OptionQuoteCoverage, "status">;
}): void {
  const { access, segment } = useCloudAccessFooter({
    delayLabel: resolveOptionsDelayLabel(chain),
    focused,
    segmentId: "options-access",
    shortcutScope: "options:upgrade",
  });
  // Trial accounts stream real-time too, but the countdown is the status worth the row.
  const coverage = access.hasProAccess && !access.isTrialActive
    ? resolveOptionsCoverageState(quoteCoverage.status)
    : null;

  const info = useMemo<PaneFooterSegment[]>(() => {
    if (coverage) {
      return [{ id: "options-access", parts: [{ text: coverage.text, tone: coverage.tone }] }];
    }
    return segment ? [segment] : [];
  }, [coverage?.text, coverage?.tone, segment]);

  usePaneStatusFooter({
    registrationId: "options",
    loading,
    error,
    info,
  });
}
