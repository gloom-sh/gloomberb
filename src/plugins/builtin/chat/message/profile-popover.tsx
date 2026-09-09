import { Button } from "../../../../components/ui";
import { Box, Text } from "../../../../ui";
import { TextAttributes } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import type { ChatUserSummary, PublicPortfolioAnalytics } from "../../../../api-client";
import { formatNumber } from "../../../../utils/format";
import { truncateChannelLabel } from "../channels";

export const PROFILE_POPOVER_CLOSE_DELAY_MS = 40;

function hasPortfolioAnalytics(analytics: PublicPortfolioAnalytics | null | undefined): boolean {
  return Boolean(
    analytics
    && (
      analytics.oneYearReturn != null
      || analytics.spyBeta != null
    ),
  );
}

export function hasPublicChatProfileInfo(user: ChatUserSummary): boolean {
  if (user.profilePublic === false) return false;
  return Boolean(user.bio?.trim() || user.title?.trim() || user.company?.trim() || hasPortfolioAnalytics(user.portfolioAnalytics));
}

export function hasChatProfileDetails(user: ChatUserSummary): boolean {
  return Boolean(user.bio?.trim() || user.title?.trim() || user.company?.trim());
}

export function shouldOfferChatProfileSetup(user: ChatUserSummary, isOwnProfile: boolean): boolean {
  return isOwnProfile && !hasChatProfileDetails(user);
}

function formatSignedPercent(value: number): string {
  const percent = value * 100;
  return `${percent >= 0 ? "+" : ""}${formatNumber(percent, 2)}%`;
}

type AnalyticsMetric = {
  id: "one-year" | "beta";
  label: string;
  value: string;
  rawValue: number;
};

function analyticsValueColor(id: string, value: number): string {
  if (id === "one-year") {
    if (value > 0) return colors.positive;
    if (value < 0) return colors.negative;
  }
  return colors.warning;
}

function analyticsMetrics(analytics: PublicPortfolioAnalytics): AnalyticsMetric[] {
  return [
    analytics.oneYearReturn != null
      ? {
        id: "one-year",
        label: "1Y",
        value: formatSignedPercent(analytics.oneYearReturn),
        rawValue: analytics.oneYearReturn,
      }
      : null,
    analytics.spyBeta != null
      ? {
        id: "beta",
        label: "Beta",
        value: formatNumber(analytics.spyBeta, 2),
        rawValue: analytics.spyBeta,
      }
      : null,
  ].filter((metric): metric is AnalyticsMetric => !!metric);
}

function headerMetricLabel(metric: AnalyticsMetric): string {
  return metric.id === "beta" ? "Beta" : metric.label;
}

function headerMetricsNaturalWidth(metrics: AnalyticsMetric[]): number {
  const metricWidth = metrics.reduce((sum, metric) => (
    sum + headerMetricLabel(metric).length + 1 + metric.value.length
  ), 0);
  return metricWidth + Math.max(0, metrics.length - 1);
}

function HeaderAnalyticsStats({
  metrics,
  width,
}: {
  metrics: AnalyticsMetric[];
  width: number;
}) {
  if (metrics.length === 0 || width < 8) return null;
  const gapWidth = Math.max(0, metrics.length - 1);
  const naturalWidths = metrics.map((metric) => headerMetricLabel(metric).length + 1 + metric.value.length);
  const availableMetricWidth = Math.max(metrics.length * 4, width - gapWidth);
  let overflow = Math.max(0, naturalWidths.reduce((sum, value) => sum + value, 0) - availableMetricWidth);
  const metricWidths = naturalWidths.map((naturalWidth, index) => {
    const shrinkable = Math.max(0, naturalWidth - 4);
    const shrink = Math.min(shrinkable, Math.ceil(overflow / (naturalWidths.length - index)));
    overflow -= shrink;
    return naturalWidth - shrink;
  });

  return (
    <Box flexDirection="row" gap={1} width={width}>
      {metrics.map((metric, index) => {
        const label = headerMetricLabel(metric);
        const metricWidth = metricWidths[index] ?? 4;
        const labelWidth = Math.max(1, Math.min(label.length, metricWidth - 2));
        const valueWidth = Math.max(1, metricWidth - labelWidth - 1);
        return (
          <Box key={metric.id} width={metricWidth} height={1} flexDirection="row" gap={1}>
            <Text fg={colors.textMuted}>{truncateChannelLabel(label, labelWidth)}</Text>
            <Text fg={analyticsValueColor(metric.id, metric.rawValue)} attributes={TextAttributes.BOLD}>
              {truncateChannelLabel(metric.value, valueWidth)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function UserProfilePopover({
  user,
  width,
  onClose,
  onKeepOpen,
  isOwnProfile = false,
  onSetUpProfile,
}: {
  user: ChatUserSummary;
  width: number;
  onClose: () => void;
  onKeepOpen: () => void;
  isOwnProfile?: boolean;
  onSetUpProfile?: () => void;
}) {
  const popoverWidth = Math.max(24, Math.min(38, width - 4));
  const meta = [user.title, user.company].filter(Boolean).join(" · ");
  const bio = user.bio?.trim();
  const analytics = user.portfolioAnalytics;
  const metrics = analytics ? analyticsMetrics(analytics) : [];
  const headerWidth = Math.max(1, popoverWidth - 2);
  const maxStatsWidth = Math.max(0, headerWidth - 8);
  const statsWidth = metrics.length > 0 && maxStatsWidth >= 8
    ? Math.min(headerMetricsNaturalWidth(metrics), maxStatsWidth)
    : 0;
  const usernameWidth = Math.max(1, headerWidth - (statsWidth > 0 ? statsWidth + 1 : 0));
  const showSetupAction = shouldOfferChatProfileSetup(user, isOwnProfile) && !!onSetUpProfile;

  return (
    <Box
      position="absolute"
      top={1}
      right={2}
      width={popoverWidth}
      flexDirection="column"
      backgroundColor={colors.panel}
      border
      borderColor={colors.borderFocused}
      paddingX={1}
      onMouseMove={onKeepOpen}
      onMouseOut={onClose}
      style={{ zIndex: 4 }}
    >
      <Box height={1} width={headerWidth} flexDirection="row">
        <Box width={usernameWidth}>
          <Text fg={colors.positive} attributes={TextAttributes.BOLD}>
            {truncateChannelLabel(user.username ? `@${user.username}` : user.displayName, usernameWidth)}
          </Text>
        </Box>
        {statsWidth > 0 ? (
          <>
            <Box width={1} />
            <HeaderAnalyticsStats metrics={metrics} width={statsWidth} />
          </>
        ) : null}
        <Box flexGrow={1} />
      </Box>
      {meta ? <Text fg={colors.textDim}>{truncateChannelLabel(meta, popoverWidth - 2)}</Text> : null}
      {bio ? (
        <Text fg={colors.text} wrapText width={popoverWidth - 2}>
          {bio}
        </Text>
      ) : null}
      {showSetupAction ? (
        <Button label="Set up profile" width={headerWidth} variant="ghost" compact stopPropagation onPress={onSetUpProfile} />
      ) : null}
    </Box>
  );
}
