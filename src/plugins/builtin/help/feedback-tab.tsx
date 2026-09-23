import { useEffect, useState, useSyncExternalStore } from "react";
import { apiClient } from "../../../api-client";
import { Badge, Button, EmptyState, Section, loadingText, unavailableText } from "../../../components";
import { subscribeFeedbackSent } from "../../../components/feedback-dialog";
import type { FeedbackReportSummary, FeedbackStatus } from "../../../feedback/types";
import { t } from "../../../i18n";
import { colors } from "../../../theme/colors";
import { Box, Text } from "../../../ui";
import { formatRelativeTime } from "../../../utils/datetime-format";
import { requestAuthDialog } from "../cloud/auth-dialog";

const STATUS_BADGES: Record<FeedbackStatus, { label: string; tone: "neutral" | "accent" | "positive" }> = {
  received: { label: "Received", tone: "neutral" },
  in_progress: { label: "In progress", tone: "accent" },
  resolved: { label: "Resolved", tone: "positive" },
};

type ReportsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; reports: FeedbackReportSummary[] };

function useSignedIn(): boolean {
  return useSyncExternalStore(
    (onChange) => apiClient.subscribeCurrentUser(onChange),
    () => apiClient.isSignedIn(),
  );
}

function ReportRow({ report, width }: { report: FeedbackReportSummary; width: number }) {
  const badge = STATUS_BADGES[report.status] ?? STATUS_BADGES.received;
  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="row" gap={1} width={width}>
        <Badge label={badge.label} tone={badge.tone} />
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text fg={colors.text} wrapMode="none" truncate flexShrink={1} minWidth={0}>{report.title}</Text>
        </Box>
        <Text fg={colors.textDim}>{formatRelativeTime(report.updatedAt)}</Text>
      </Box>
      {report.latestReply && (
        <Box paddingLeft={2} width={width}>
          <Text fg={colors.textDim} wrapText width={Math.max(1, width - 2)}>{report.latestReply}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Help's Feedback tab: the reports already sent, with their status and the
 * team's latest reply. Replies also arrive by email; this is where they can
 * be checked without leaving the terminal. Sending, the debug log and GitHub
 * issues are the tab's footer hints.
 */
export function FeedbackTab({ width }: { width: number }) {
  const signedIn = useSignedIn();
  const [state, setState] = useState<ReportsState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => subscribeFeedbackSent(() => setReloadKey((key) => key + 1)), []);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    setState((current) => (current.status === "loaded" ? current : { status: "loading" }));
    apiClient.listFeedback()
      .then((reports) => {
        if (!cancelled) setState({ status: "loaded", reports });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "" });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, reloadKey]);

  return (
    <Section title="Your Reports" marginTop={0}>
      {!signedIn ? (
        <Box flexDirection="row">
          <Button label="Sign in to follow your reports" variant="plain" compact flush onPress={() => { requestAuthDialog(); }} />
        </Box>
      ) : state.status === "loading" ? (
        <Text fg={colors.textDim}>{loadingText(t("reports"))}</Text>
      ) : state.status === "error" ? (
        <EmptyState status="error" title={unavailableText(t("Reports"))} message={state.message || undefined} />
      ) : state.reports.length === 0 ? (
        <EmptyState title="No reports yet" />
      ) : (
        <Box flexDirection="column" gap={1}>
          {state.reports.map((report) => <ReportRow key={report.id} report={report} width={width} />)}
        </Box>
      )}
    </Section>
  );
}
