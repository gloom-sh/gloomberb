import { useMemo } from "react";
import type { PaneFooterSegment, PaneHint } from "../../../components";
import { t, tf } from "../../../i18n";
import type { OptionsChain } from "../../../types/financials";
import { formatRelativeTime } from "../../../utils/datetime-format";
import { useCloudAccessFooter } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { CLOUD_QUOTE_DELAY_MINUTES } from "../shared/plan-access";
import type { OptionQuoteCoverage, OptionQuoteCoverageStatus } from "./live-quotes";
import { optionSpread, type OptionMarketReference } from "./market-reference";

export interface OptionsCoverageState {
  text: string;
  tone: "muted" | "positive" | "warning";
}

/** Stream coverage the pane reports once the account is entitled to real-time options. */
export function resolveOptionsCoverageState(status: OptionQuoteCoverageStatus): OptionsCoverageState | null {
  if (status === "live") return { text: t("real-time options"), tone: "positive" };
  if (status === "mixed") return { text: t("mixed real-time and delayed options"), tone: "warning" };
  // The stream connects in the background; nothing to report until it answers.
  if (status === "connecting") return null;
  return { text: t("options delayed fallback"), tone: "warning" };
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
        { text: `${spread.spread} (${spread.percentOfMid.toFixed(1)}% of mid)`, tone: "value" },
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
  chain,
  error,
  focused,
  hints,
  loading,
  quoteCoverage,
  reference,
  spreadColumnVisible,
}: {
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
  const { access, hint: upgradeHint, segment } = useCloudAccessFooter({
    delayLabel: resolveOptionsDelayLabel(chain),
    focused,
    segmentId: "options-access",
    shortcutScope: "options:upgrade",
  });
  // Trial accounts stream real-time too, but the countdown is the status worth the row.
  const coverage = access.hasProAccess && !access.isTrialActive
    ? resolveOptionsCoverageState(quoteCoverage.status)
    : null;

  const accessInfo = useMemo<PaneFooterSegment[]>(() => {
    if (coverage) {
      return [{ id: "options-access", parts: [{ text: coverage.text, tone: coverage.tone }] }];
    }
    return segment ? [segment] : [];
  }, [coverage?.text, coverage?.tone, segment]);

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
