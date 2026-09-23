import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudEquityDiagnosticCoverage,
  CloudEquityDiagnosticEvidence,
  CloudEquityDiagnosticFinding,
  CloudEquityDiagnosticFindingKind,
  CloudEquityDiagnosticMode,
  CloudEquityDiagnosticResponse,
} from "../../../api-client";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { Button, ChoiceDialog, EmptyState, PaneStatusBody, SectionHeading, Spinner, usePaneFooter, usePaneMenuItems } from "../../../components";
import { ExternalLinkText, PaneLinkMenu } from "../../../components/ui";
import { t, tf } from "../../../i18n";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { Box, ScrollBox, Text, TextAttributes, useRendererHost, useUiCapabilities } from "../../../ui";
import { useOptionalDialog, type PromptContext } from "../../../ui/dialog";
import { formatTimeAgo, truncateToDisplayWidth } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { SignInWall } from "../cloud/auth-actions";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { usePlanAccess } from "../shared/plan-access";
import { useBoundTicker } from "../shared/ticker-request";

const FOOTER_ID = "equity-diagnostic";
const REFRESH_SCOPE = "equity-diagnostic:refresh";
/** Width of the "Observed"/"Reading" label column before the layout stacks. */
const LABEL_WIDTH = 10;
const STACK_BELOW_WIDTH = 44;
const COVERAGE_LABEL_WIDTH = 16;
const LOADING_STEPS = [
  "Market data",
  "SEC EDGAR filings",
  "FINRA short interest",
  "News",
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

function sortFindings(findings: readonly CloudEquityDiagnosticFinding[]): CloudEquityDiagnosticFinding[] {
  return [...findings].sort((left, right) => (
    right.severity - left.severity || right.confidence - left.confidence
  ));
}

const FINDING_SECTION_ORDER: readonly CloudEquityDiagnosticFindingKind[] = ["red_flag", "anomaly", "green_flag"];

interface CitedSource {
  id: string;
  label: string;
  finding: string;
  url: string;
}

/**
 * The linked evidence behind the findings on screen, in reading order: the
 * preview's one finding, or every section of the full report.
 */
function citedSources(report: CloudEquityDiagnosticResponse): CitedSource[] {
  const evidenceById = new Map(report.evidence.map((evidence) => [evidence.id, evidence]));
  const sorted = sortFindings(report.findings);
  const findings = report.access === "preview"
    ? report.findings.slice(0, 1)
    : FINDING_SECTION_ORDER.flatMap((kind) => sorted.filter((finding) => finding.kind === kind));
  const sources: CitedSource[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    for (const evidenceId of finding.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence?.url || seen.has(evidence.id)) continue;
      seen.add(evidence.id);
      sources.push({ id: evidence.id, label: citationLabel(evidence), finding: finding.title, url: evidence.url });
    }
  }
  return sources;
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
      <SectionHeading title={heading} />
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
      <SectionHeading title="COVERAGE" />
      {coverage.map((entry) => {
        const detail = [
          coverageLabel(entry.status),
          entry.asOf?.slice(0, 10),
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

function ReportView({ report, width }: {
  report: CloudEquityDiagnosticResponse;
  width: number;
}) {
  const evidenceById = useMemo(
    () => new Map(report.evidence.map((evidence) => [evidence.id, evidence])),
    [report.evidence],
  );
  const sorted = useMemo(() => sortFindings(report.findings), [report.findings]);
  const byKind = (kind: CloudEquityDiagnosticFindingKind) => sorted.filter((finding) => finding.kind === kind);
  // When the report was generated is status, so it lives in the footer.
  const meta = [
    report.companyName,
    tf("confidence {value}", { value: percent(report.confidence) }),
  ].filter(Boolean).join(" · ");

  // Every citation is also a pane menu entry, so the report's sources open
  // without a pointer.
  return (
    <PaneLinkMenu>
      <Box flexDirection="column" width={width} gap={1}>
        <Box flexDirection="column" width={width}>
          <Box height={1}>
            <Text fg={verdictColor(report.verdict)} attributes={TextAttributes.BOLD}>
              {verdictLabel(report.verdict)}
            </Text>
          </Box>
          <Paragraph text={meta} width={width} color={colors.textMuted} />
        </Box>

        {report.status === "insufficient_data"
          ? <EmptyState title="Not enough coverage to review this company yet." message={report.summary} />
          : <Paragraph text={report.summary} width={width} color={colors.text} />}

        <FindingSection heading="RED FLAGS" findings={byKind("red_flag")} evidenceById={evidenceById} width={width} />
        <FindingSection heading="ANOMALIES" findings={byKind("anomaly")} evidenceById={evidenceById} width={width} />
        <FindingSection heading="GREEN FLAGS" findings={byKind("green_flag")} evidenceById={evidenceById} width={width} />

        {report.watchItems.length > 0 && (
          <Box flexDirection="column" width={width}>
            <SectionHeading title="WATCH ITEMS" />
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
    </PaneLinkMenu>
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
  ].filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Paragraph text={meta} width={width} color={colors.textMuted} />
      {finding
        ? <FindingView finding={finding} evidenceById={evidenceById} width={width} />
        : <EmptyState title="No preview finding is available for this company yet." />}
      <Box flexDirection="column" width={width}>
        <SectionHeading title="UNLOCK THE FULL DIAGNOSTIC" />
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

  // The report's citations are links a keyboard cannot focus, so `o` opens
  // them: straight away for one, through a chooser for several.
  const reportShown = !!symbol && !!report && !signInRequired && !verificationRequired && !proRequired;
  const sources = useMemo(() => (reportShown && report ? citedSources(report) : []), [report, reportShown]);
  const rendererHost = useRendererHost();
  const dialog = useOptionalDialog();
  const openSource = useCallback(() => {
    const [only] = sources;
    if (!only) return;
    if (sources.length === 1 || !dialog) {
      void rendererHost.openExternal(only.url);
      return;
    }
    void dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (context: PromptContext<string>) => (
        <ChoiceDialog
          {...context}
          title={t("Open Source")}
          choices={sources.map((source) => ({ id: source.id, label: source.label, description: source.finding }))}
        />
      ),
    }).then((sourceId) => {
      const source = sources.find((entry) => entry.id === sourceId);
      if (source) void rendererHost.openExternal(source.url);
    }).catch(() => {});
  }, [dialog, rendererHost, sources]);

  // The preview's pitch sits in the body, not an empty state, so its buttons
  // reach the keyboard through the pane menu instead of Enter.
  const previewShown = reportShown && report?.access === "preview";
  usePaneMenuItems("equity-diagnostic:upgrade", () => previewShown ? [
    { id: "upgrade", label: t("Upgrade to Pro"), onSelect: () => openUpgrade() },
    { id: "manage-account", label: t("Manage account"), onSelect: openPlan },
  ] : null, [openPlan, openUpgrade, previewShown]);

  usePaneFooter(FOOTER_ID, () => ({
    info: [
      ...(loading ? [{ id: "loading", parts: [{ text: t("scanning"), tone: "muted" as const }] }] : []),
      ...(failure ? [{ id: "error", parts: [{ text: failureText(failure), tone: "warning" as const }] }] : []),
      ...(report?.access === "full" && report.status === "partial"
        ? [{ id: "partial", parts: [{ text: t("partial"), tone: "warning" as const }] }]
        : []),
      ...(report?.stale ? [{ id: "stale", parts: [{ text: t("stale"), tone: "warning" as const }] }] : []),
      ...(report?.cached && !report.stale ? [{ id: "cached", parts: [{ text: t("cached"), tone: "muted" as const }] }] : []),
      ...(report ? [{ id: "generated", parts: [{ text: tf("generated {age}", { age: formatTimeAgo(report.generatedAt) }), tone: "muted" as const }] }] : []),
    ],
    hints: sources.length > 0
      ? [{ id: "source", key: "o", label: "pen source", title: sources.length > 1 ? "Open Source…" : "Open Source", onPress: openSource }]
      : [],
  }), [failure, loading, openSource, report, sources.length]);

  const contentWidth = Math.max(12, width - 2);

  // Walls and empty states are drawn straight into the pane, like every other
  // pane's; only a report sits in the padded scroll area.
  if (!symbol) {
    return <PaneStatusBody empty emptyTitle="No ticker selected." emptyMessage="Move the cursor in a list pane to populate this view." />;
  }
  if (signInRequired || verificationRequired) {
    return <SignInWall action="run the Equity Diagnostic" needsVerification={verificationRequired} />;
  }
  // Buttons in an empty state's actions answer Enter and are in the pane menu.
  if (proRequired) {
    return (
      <PaneStatusBody
        empty
        emptyTitle="The Equity Diagnostic is part of Gloom Cloud Pro."
        emptyMessage="An on-demand review of one company's filings, financials, ownership, and news, with red flags, anomalies, and green flags cited back to their source."
        actions={<>
          <Button label={t("Upgrade to Pro")} onPress={openUpgrade} />
          <Button label={t("Manage account")} variant="secondary" onPress={openPlan} />
        </>}
      />
    );
  }
  if (loading && !report) {
    return <Box paddingX={1} paddingY={1}><DiagnosticLoading step={loadingStep} /></Box>;
  }
  if (!report) {
    const retryAction = <Button label="Retry" variant="secondary" onPress={retry} />;
    return failure
      ? <PaneStatusBody error={failureText(failure)} actions={retryAction} />
      : <PaneStatusBody empty emptyTitle={t("No diagnostic available yet.")} actions={retryAction} />;
  }

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
          {report.access === "preview"
            ? <PreviewReportView report={report} width={contentWidth} onUpgrade={openUpgrade} onPlan={openPlan} />
            : <ReportView report={report} width={contentWidth} />}
        </Box>
      </ScrollBox>
    </Box>
  );
}
