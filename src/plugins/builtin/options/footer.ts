import { useMemo } from "react";
import type { PaneFooterSegment, PaneHint } from "../../../components";
import { delayedFooterSegment } from "../../../components/layout/pane/footer/model";
import { t, tf } from "../../../i18n";
import type { OptionsChain } from "../../../types/financials";
import { formatRelativeTime } from "../../../utils/datetime-format";
import { useCloudAccessFooter } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { CLOUD_QUOTE_DELAY_MINUTES } from "../../../api-client/plan-access";
import type { OptionQuoteCoverage, OptionQuoteCoverageStatus } from "./live-quotes";
import { formatOptionPrice, optionSpread, type OptionMarketReference } from "./market-reference";

/**
 * Stream coverage the pane reports once the account is entitled to real-time
 * options. Delayed quotes, all or some, are the footer's clock, its detail on
 * hover.
 */
export function optionsCoverageSegment(status: OptionQuoteCoverageStatus, delayLabel?: string): PaneFooterSegment | null {
  const id = "options-access";
  if (status === "live") return { id, parts: [{ text: t("real-time options"), tone: "positive" }] };
  if (status === "mixed") return delayedFooterSegment({ id, detail: t("mixed real-time and delayed options") });
  // The stream connects in the background; nothing to report until it answers.
  if (status === "connecting") return null;
  return delayedFooterSegment({ id, detail: t("Delayed options quotes, real-time stream unavailable"), delay: delayLabel });
}

/**
 * The selected contract belongs in the status bar rather than above the chain:
 * it changes on every cursor move, and the chain already carries the contract's
 * bid, ask and last as columns, its expiry as the tab strip above them. What is
 * left is the identity, how stale the two clocks are, and whatever the chain's
 * own columns cannot say about the quote.
 */
export function optionContractFooterSegments(
  reference: OptionMarketReference | undefined,
  spreadColumnVisible = false,
  now = Date.now(),
): PaneFooterSegment[] {
  if (!reference) return [];
  const spread = optionSpread(reference);
  const age = (milliseconds: number | undefined) => milliseconds && milliseconds > 0
    ? formatRelativeTime(milliseconds, now) : null;
  const quoteAge = age(reference.lastUpdated);
  const tradeAge = age(reference.lastTradeDate * 1000);
  // A visible SPRD column already prints the percentage on every row, so the
  // status bar only adds the absolute width it leaves out. It always names the
  // reason a quote has no midpoint, which the column can only render as a dash.
  const spreadSegment: PaneFooterSegment | null = spread.kind !== "two-sided"
    ? {
      id: "options-spread",
      parts: [{
        text: spread.kind === "crossed" ? t("crossed quote")
          : spread.kind === "one-sided" ? t("one-sided quote") : t("no bid/ask"),
        tone: "warning",
      }],
    }
    : spreadColumnVisible ? null : {
      id: "options-spread",
      parts: [
        { text: "spread", tone: "label" },
        { text: `${formatOptionPrice(spread.spread)} (${spread.percentOfMid.toFixed(1)}% of mid)`, tone: "value" },
      ],
    };
  return [
    { id: "options-contract", parts: [{ text: reference.contractSymbol, tone: "value" }] },
    ...(spreadSegment ? [spreadSegment] : []),
    ...(quoteAge ? [{
      id: "options-quote-age",
      parts: [{ text: "quote", tone: "label" as const }, { text: quoteAge, tone: "value" as const }],
    }] : []),
    ...(tradeAge ? [{
      id: "options-trade-age",
      parts: [{ text: "trade", tone: "label" as const }, { text: tradeAge, tone: "value" as const }],
    }] : []),
  ];
}

export function resolveOptionsDelayLabel(chain: OptionsChain | null | undefined): string {
  const delayMinutes = chain?.delayMinutes && chain.delayMinutes > 0
    ? chain.delayMinutes
    : CLOUD_QUOTE_DELAY_MINUTES;
  return tf("{count}m", { count: delayMinutes });
}

export function useOptionsAccessFooter({
  broker = false,
  chain,
  error,
  focused,
  hints,
  loading,
  quoteCoverage,
  reference,
  spreadColumnVisible,
}: {
  /** The chain is a broker profile's, quoted by that broker: it has no Gloom Cloud delay to report or upgrade from. */
  broker?: boolean;
  chain: OptionsChain | null | undefined;
  error?: string | null;
  focused: boolean;
  hints?: PaneHint[];
  loading?: boolean;
  quoteCoverage: Pick<OptionQuoteCoverage, "status">;
  /** The contract under the cursor, reported as status rather than as a header. */
  reference?: OptionMarketReference | undefined;
  /** Set while the chain prints a SPRD column, so the status bar stops repeating it. */
  spreadColumnVisible?: boolean;
}): void {
  const delayLabel = resolveOptionsDelayLabel(chain);
  const { access, hint: upgradeHint, segment } = useCloudAccessFooter({
    delayLabel,
    degraded: !broker,
    focused,
    segmentId: "options-access",
    placement: "omon-footer",
    shortcutScope: "options:upgrade",
  });
  // Trial accounts stream real-time too, but the countdown is the status worth the row. A broker's
  // chain streams from the broker whatever the plan, so its coverage is the status, and its delay
  // is the chain's own, not Gloom Cloud's.
  const proCoverage = broker || (access.hasProAccess && !access.isTrialActive);
  const coverageDelay = broker && !(chain?.delayMinutes && chain.delayMinutes > 0) ? undefined : delayLabel;
  const accessInfo = useMemo<PaneFooterSegment[]>(() => {
    const coverage = proCoverage ? optionsCoverageSegment(quoteCoverage.status, coverageDelay) : null;
    if (coverage) return [coverage];
    return segment ? [segment] : [];
  }, [coverageDelay, proCoverage, quoteCoverage.status, segment]);

  // Rebuilt every render so the quote and trade ages keep counting with the
  // stream; the registration compares by value, so only a changed label
  // reaches the footer. Access leads: for a free account it is the pressable
  // upgrade segment, and the info row truncates from the right.
  const info = [...accessInfo, ...optionContractFooterSegments(reference, spreadColumnVisible)];

  usePaneStatusFooter({
    registrationId: "options",
    loading,
    error,
    info,
    // The pane's own actions keep the right edge they already hold.
    hints: upgradeHint ? [upgradeHint, ...(hints ?? [])] : hints,
  });
}
