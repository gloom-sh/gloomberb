import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { Button, EmptyState, Spinner, usePaneFooter } from "../../../components";
import { ExternalLinkText } from "../../../components/ui";
import { CloudAuthNotice } from "../cloud/auth-actions";
import { apiClient } from "../../../api-client";
import type {
  CloudEquityDiagnosticCoverage,
  CloudEquityDiagnosticEvidence,
  CloudEquityDiagnosticFinding,
  CloudEquityDiagnosticFindingKind,
  CloudEquityDiagnosticMode,
  CloudEquityDiagnosticResponse,
} from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import { useShortcut } from "../../../react/input";
import { formatTimeAgo, truncateToDisplayWidth } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { usePlanAccess } from "../shared/plan-access";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { useBoundTicker } from "../shared/ticker-request";

const FOOTER_ID = "equity-diagnostic";
const REFRESH_SCOPE = "equity-diagnostic:refresh";
/** Width of the "Observed"/"Reading" label column before the layout stacks. */
const LABEL_WIDTH = 10;
const STACK_BELOW_WIDTH = 44;
const COVERAGE_LABEL_WIDTH = 16;
const LOADING_STEPS = [
  "Gloom Cloud market data",
  "SEC EDGAR filings",
  "FINRA short interest",
  "Gloom News",
  "Reviewing evidence",
] as const;

interface DiagnosticFailure {
  status?: number;
  message: string;
}

function toFailure(error: unknown): DiagnosticFailure {
  return {
    status: error instanceof ApiRequestError ? error.status : undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

function failureText(failure: DiagnosticFailure): string {
  if (failure.status === 429) return t("Rate limited. Try again in a moment.");
  if (failure.status != null && failure.status >= 500) return t("Diagnostic service is unavailable.");
  return failure.message;
}

/**
 * One report request per visited surface. A failed refresh keeps the report the
 * user is already reading, so a rate limit or an outage never blanks the pane.
 */
function useEquityDiagnostic(symbol: string | null, exchange: string, enabled: boolean) {
  const [state, setState] = useState<{
    report: CloudEquityDiagnosticResponse | null;
    loading: boolean;
    loadingStep: number;
    failure: DiagnosticFailure | null;
  }>({ report: null, loading: false, loadingStep: 0, failure: null });
  const generationRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const load = useCallback((mode: CloudEquityDiagnosticMode) => {
    if (!symbol || !enabled) return;
    clearPoll();
    generationRef.current += 1;
    const generation = generationRef.current;
    setState((current) => ({ ...current, loading: true, loadingStep: 1, failure: null }));

    const request = (nextMode: CloudEquityDiagnosticMode) => {
      apiClient.getCloudEquityDiagnostic(symbol, exchange || undefined, nextMode)
        .then((result) => {
          if (generationRef.current !== generation) return;
          if (result.status === "generating") {
            setState((current) => ({
              ...current,
              loadingStep: Math.min(LOADING_STEPS.length, current.loadingStep + 1),
            }));
            const retryAfterMs = Math.max(10, Math.min(5_000, result.retryAfterMs));
            pollTimerRef.current = setTimeout(() => request("cache-first"), retryAfterMs);
            return;
          }
          clearPoll();
          setState({ report: result, loading: false, loadingStep: 0, failure: null });
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generation) return;
          clearPoll();
          setState((current) => ({
            report: current.report,
            loading: false,
            loadingStep: 0,
            failure: toFailure(error),
          }));
        });
    };

    request(mode);
  }, [clearPoll, enabled, exchange, symbol]);

  useEffect(() => {
    // A report belongs to one company, so drop it rather than show it under the next.
    generationRef.current += 1;
    clearPoll();
    setState({ report: null, loading: false, loadingStep: 0, failure: null });
    load("cache-first");
    return clearPoll;
  }, [clearPoll, load]);

  return { ...state, load };
}

function verdictLabel(verdict: CloudEquityDiagnosticResponse["verdict"]): string {
  switch (verdict) {
    case "risk_skewed": return t("Risk skewed");
    case "opportunity_skewed": return t("Opportunity skewed");
    case "balanced": return t("Balanced");
    default: return t("Unclear");
  }
}

function verdictColor(verdict: CloudEquityDiagnosticResponse["verdict"]): string {
  switch (verdict) {
    case "risk_skewed": return colors.negative;
    case "opportunity_skewed": return colors.positive;
    case "balanced": return colors.text;
    default: return colors.textDim;
  }
}

function findingColor(kind: CloudEquityDiagnosticFindingKind): string {
  switch (kind) {
    case "red_flag": return colors.negative;
    case "green_flag": return colors.positive;
    default: return colors.warning;
  }
}

function severityLabel(severity: CloudEquityDiagnosticFinding["severity"]): string {
  if (severity >= 3) return t("HIGH");
  if (severity === 2) return t("MEDIUM");
  return t("LOW");
}

function coverageColor(status: CloudEquityDiagnosticCoverage["status"]): string {
  if (status === "available") return colors.textDim;
  return status === "failed" ? colors.warning : colors.textMuted;
}

function coverageLabel(status: CloudEquityDiagnosticCoverage["status"]): string {
  switch (status) {
    case "available": return t("available");
    case "no_data": return t("no data");
    case "unsupported": return t("unsupported");
    default: return t("failed");
  }
}

function percent(value: number): string {
  const scaled = value <= 1 ? value * 100 : value;
  return `${Math.round(scaled)}%`;
}

function citationLabel(evidence: CloudEquityDiagnosticEvidence): string {
  const date = evidence.asOf?.slice(0, 10);
  return date && !evidence.label.includes(date) ? `${evidence.label} ${date}` : evidence.label;
}

function datasetLabel(dataset: string): string {
  return dataset.replaceAll("_", " ");
}

function providerLabel(provider?: string): string | undefined {
  if (!provider) return undefined;
  if (provider === "Gloomberb News") return "Gloom News";
  if (provider.includes("Twelve Data") || provider === "Market data providers") return "Gloom Cloud";
  return provider;
}

function sortFindings(findings: readonly CloudEquityDiagnosticFinding[]): CloudEquityDiagnosticFinding[] {
  return [...findings].sort((left, right) => (
    right.severity - left.severity || right.confidence - left.confidence
  ));
}

function Paragraph({ text: value, width, color, bold }: {
  text: string;
  width: number;
  color: string;
  bold?: boolean;
}) {
  return (
    <Text
      fg={color}
      width={width}
      wrapText
      wrapMode="word"
      attributes={bold ? TextAttributes.BOLD : undefined}
    >
      {value}
    </Text>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <Box height={1}>
      <Text fg={colors.textMuted} attributes={TextAttributes.BOLD}>{t(label)}</Text>
    </Box>
  );
}

function DiagnosticLoading({ step }: { step: number }) {
  const visible = LOADING_STEPS.slice(0, Math.max(1, step));
  return (
    <Box flexDirection="column" gap={1}>
      {visible.slice(0, -1).map((label) => (
        <Text key={label} fg={colors.textDim}>{t(label)}</Text>
      ))}
      <Spinner label={`${t(visible.at(-1) ?? LOADING_STEPS[0])}...`} />
    </Box>
  );
}

/** Label plus body text, stacked instead of columned once the pane gets narrow. */
function LabeledText({ label, text: value, width, color }: {
  label: string;
  text: string;
  width: number;
  color: string;
}) {
  if (width < STACK_BELOW_WIDTH) {
    return (
      <Box flexDirection="column" width={width}>
        <Box height={1}><Text fg={colors.textMuted}>{t(label)}</Text></Box>
        <Paragraph text={value} width={width} color={color} />
      </Box>
    );
  }

  return (
    <Box flexDirection="row" width={width}>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text fg={colors.textMuted}>{t(label)}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} minWidth={0}>
        <Paragraph text={value} width={width - LABEL_WIDTH} color={color} />
      </Box>
    </Box>
  );
}

function FindingView({ finding, evidenceById, width }: {
  finding: CloudEquityDiagnosticFinding;
  evidenceById: Map<string, CloudEquityDiagnosticEvidence>;
  width: number;
}) {
  const kindColor = findingColor(finding.kind);
  const citations = finding.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((evidence): evidence is CloudEquityDiagnosticEvidence => !!evidence);

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" width={width}>
        <Box width={8} flexShrink={0}>
          <Text fg={kindColor} attributes={TextAttributes.BOLD}>{severityLabel(finding.severity)}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          <Paragraph text={finding.title} width={width - 8} color={colors.textBright} bold />
        </Box>
      </Box>
      <LabeledText label="Observed" text={finding.observation} width={width} color={colors.text} />
      <LabeledText label="Reading" text={finding.interpretation} width={width} color={colors.textDim} />
      <Box flexDirection="row" flexWrap="wrap" width={width}>
        <Text fg={colors.textMuted}>{tf("{value} confidence", { value: percent(finding.confidence) })}</Text>
        {citations.map((evidence) => (
          <Box key={evidence.id} flexDirection="row">
            <Text fg={colors.textMuted}>{"  ·  "}</Text>
            {evidence.url
              ? <ExternalLinkText url={evidence.url} label={citationLabel(evidence)} color={colors.textDim} />
              : <Text fg={colors.textMuted}>{citationLabel(evidence)}</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function FindingSection({ heading, findings, evidenceById, width }: {
  heading: string;
  findings: CloudEquityDiagnosticFinding[];
  evidenceById: Map<string, CloudEquityDiagnosticEvidence>;
  width: number;
}) {
  if (findings.length === 0) return null;
  return (
    <Box flexDirection="column" width={width} gap={1}>
      <SectionHeading label={heading} />
      {findings.map((finding) => (
        <FindingView key={finding.id} finding={finding} evidenceById={evidenceById} width={width} />
      ))}
    </Box>
  );
}

function CoverageSection({ coverage, width }: {
  coverage: CloudEquityDiagnosticCoverage[];
  width: number;
}) {
  if (coverage.length === 0) return null;
  const detailWidth = Math.max(12, width - COVERAGE_LABEL_WIDTH);

  return (
    <Box flexDirection="column" width={width}>
      <SectionHeading label="COVERAGE" />
      {coverage.map((entry) => {
        const detail = [
          coverageLabel(entry.status),
          entry.asOf?.slice(0, 10),
          providerLabel(entry.provider),
          entry.note,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Box key={`${entry.dataset}:${entry.status}`} flexDirection="row" width={width}>
            <Box width={COVERAGE_LABEL_WIDTH} flexShrink={0}>
              <Text fg={colors.textDim}>
                {truncateToDisplayWidth(datasetLabel(entry.dataset), COVERAGE_LABEL_WIDTH - 1)}
              </Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} minWidth={0}>
              <Paragraph text={detail} width={detailWidth} color={coverageColor(entry.status)} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function ReportView({ report, width, failure, onRetry }: {
  report: CloudEquityDiagnosticResponse;
  width: number;
  failure: DiagnosticFailure | null;
  onRetry: () => void;
}) {
  const evidenceById = useMemo(
    () => new Map(report.evidence.map((evidence) => [evidence.id, evidence])),
    [report.evidence],
  );
  const sorted = useMemo(() => sortFindings(report.findings), [report.findings]);
  const byKind = (kind: CloudEquityDiagnosticFindingKind) => sorted.filter((finding) => finding.kind === kind);
  const meta = [
    report.companyName,
    tf("generated {age}", { age: formatTimeAgo(report.generatedAt) }),
    tf("confidence {value}", { value: percent(report.confidence) }),
  ].filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Box flexDirection="column" width={width}>
        <Box height={1}>
          <Text fg={verdictColor(report.verdict)} attributes={TextAttributes.BOLD}>
            {verdictLabel(report.verdict)}
          </Text>
        </Box>
        <Paragraph text={meta} width={width} color={colors.textMuted} />
      </Box>

      {failure && (
        <Box flexDirection="row" gap={1} width={width}>
          <Text fg={colors.warning}>{failureText(failure)}</Text>
          <Button label="Retry" variant="secondary" onPress={onRetry} />
        </Box>
      )}

      {report.status === "insufficient_data"
        ? <EmptyState title="Not enough coverage to review this company yet." message={report.summary} />
        : <Paragraph text={report.summary} width={width} color={colors.text} />}

      <FindingSection heading="RED FLAGS" findings={byKind("red_flag")} evidenceById={evidenceById} width={width} />
      <FindingSection heading="ANOMALIES" findings={byKind("anomaly")} evidenceById={evidenceById} width={width} />
      <FindingSection heading="GREEN FLAGS" findings={byKind("green_flag")} evidenceById={evidenceById} width={width} />

      {report.watchItems.length > 0 && (
        <Box flexDirection="column" width={width}>
          <SectionHeading label="WATCH ITEMS" />
          {report.watchItems.map((item, index) => (
            <Box key={`${index}:${item.slice(0, 24)}`} flexDirection="row" width={width}>
              <Box width={2} flexShrink={0}><Text fg={colors.textMuted}>{"· "}</Text></Box>
              <Box flexDirection="column" flexGrow={1} minWidth={0}>
                <Paragraph text={item} width={width - 2} color={colors.text} />
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <CoverageSection coverage={report.coverage} width={width} />
    </Box>
  );
}

function PreviewReportView({ report, width, onUpgrade, onPlan }: {
  report: CloudEquityDiagnosticResponse;
  width: number;
  onUpgrade: () => void;
  onPlan: () => void;
}) {
  const evidenceById = useMemo(
    () => new Map(report.evidence.map((evidence) => [evidence.id, evidence])),
    [report.evidence],
  );
  const finding = report.findings[0];
  const meta = [
    report.companyName,
    t("Free preview"),
    tf("generated {age}", { age: formatTimeAgo(report.generatedAt) }),
  ].filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Paragraph text={meta} width={width} color={colors.textMuted} />
      {finding
        ? <FindingView finding={finding} evidenceById={evidenceById} width={width} />
        : <EmptyState title="No preview finding is available for this company yet." />}
      <Box flexDirection="column" width={width}>
        <SectionHeading label="UNLOCK THE FULL DIAGNOSTIC" />
        <Paragraph
          text={t("See the overall verdict, every red flag, anomaly, green flag, and watch item.")}
          width={width}
          color={colors.text}
        />
        <Box flexDirection="row" marginTop={1} gap={1}>
          <Button label={t("Upgrade to Pro")} onPress={onUpgrade} />
          <Button label={t("Manage account")} variant="secondary" onPress={onPlan} />
        </Box>
      </Box>
      <CoverageSection coverage={report.coverage} width={width} />
    </Box>
  );
}

export function EquityDiagnosticView({ focused, width }: {
  focused: boolean;
  width: number;
  height: number;
}) {
  const { symbol, exchange } = useBoundTicker();
  const access = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();
  const { nativePaneChrome } = useUiCapabilities();

  const requestEnabled = access.emailVerified;
  const { report, loading, loadingStep, failure, load } = useEquityDiagnostic(
    symbol,
    exchange,
    requestEnabled,
  );

  const signInRequired = !access.signedIn || failure?.status === 401;
  const verificationRequired = !signInRequired && (!access.emailVerified || failure?.status === 403);
  const proRequired = !signInRequired && !verificationRequired && failure?.status === 402;
  const canRefresh = !!symbol && access.hasProAccess && !signInRequired && !verificationRequired && !proRequired;

  const refresh = useCallback(() => load("refresh"), [load]);
  const retry = useCallback(() => load("cache-first"), [load]);

  useShortcut((event) => {
    if (!isPlainKey(event, "r")) return;
    event.preventDefault();
    event.stopPropagation();
    refresh();
  }, { enabled: focused && canRefresh && !loading, scope: REFRESH_SCOPE });

  usePaneFooter(FOOTER_ID, () => ({
    info: [
      ...(loading ? [{ id: "loading", parts: [{ text: t("scanning"), tone: "muted" as const }] }] : []),
      ...(failure ? [{ id: "error", parts: [{ text: failureText(failure), tone: "warning" as const }] }] : []),
      ...(report?.access === "full" && report.status === "partial"
        ? [{ id: "partial", parts: [{ text: t("partial"), tone: "warning" as const }] }]
        : []),
      ...(report?.stale ? [{ id: "stale", parts: [{ text: t("stale"), tone: "warning" as const }] }] : []),
      ...(report?.cached && !report.stale ? [{ id: "cached", parts: [{ text: t("cached"), tone: "muted" as const }] }] : []),
    ],
    hints: canRefresh
      ? [{ id: "refresh", key: "r", label: "efresh", onPress: refresh, disabled: loading }]
      : [],
  }), [canRefresh, failure, loading, refresh, report]);

  const contentWidth = Math.max(12, width - 2);

  const body = (): ReactNode => {
    if (!symbol) {
      return (
        <EmptyState
          title="No ticker selected."
          hint="Move the cursor in a list pane to populate this view."
        />
      );
    }
    if (signInRequired) {
      return <CloudAuthNotice message={t("Sign in to run the Equity Diagnostic.")} />;
    }
    if (verificationRequired) {
      return <CloudAuthNotice needsVerification message={t("Verify your email to run the Equity Diagnostic.")} />;
    }
    if (proRequired) {
      return (
        <Box flexDirection="column">
          <EmptyState
            title="The Equity Diagnostic is part of Gloom Cloud Pro."
            message="An on-demand review of one company's filings, financials, ownership, and news, with red flags, anomalies, and green flags cited back to their source."
          />
          <Box flexDirection="row" marginTop={1} gap={1}>
            <Button label={t("Upgrade to Pro")} onPress={openUpgrade} />
            <Button label={t("Manage account")} variant="secondary" onPress={openPlan} />
          </Box>
        </Box>
      );
    }
    if (loading && !report) {
      return <DiagnosticLoading step={loadingStep} />;
    }
    if (!report) {
      return (
        <Box flexDirection="column">
          <EmptyState
            title={failure ? failureText(failure) : t("No diagnostic available yet.")}
          />
          <Box flexDirection="row" marginTop={1}>
            <Button label="Retry" variant="secondary" onPress={retry} />
          </Box>
        </Box>
      );
    }
    if (report.access === "preview") {
      return (
        <PreviewReportView
          report={report}
          width={contentWidth}
          onUpgrade={openUpgrade}
          onPlan={openPlan}
        />
      );
    }
    return <ReportView report={report} width={contentWidth} failure={failure} onRetry={retry} />;
  };

  return (
    <Box
      flexDirection="column"
      width={nativePaneChrome ? "100%" : width}
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      <ScrollBox flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        <Box flexDirection="column" paddingX={1} paddingY={1} width={nativePaneChrome ? "100%" : width}>
          {body()}
        </Box>
      </ScrollBox>
    </Box>
  );
}
