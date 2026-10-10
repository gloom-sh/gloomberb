import { Button, Popover } from "../../../../components/ui";
import { Box, Text, useUiCapabilities } from "../../../../ui";
import { TextAttributes } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import type { ChatUserSummary, PublicPortfolioAnalytics } from "../../../../api-client";
import { displayWidth, formatNumber, truncateToDisplayWidth } from "../../../../utils/format";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import { isDiscordGhost } from "../ghost-user";
import type { ChatUserAnchor } from "./types";

/**
 * How long a card the pointer left stays: long enough to move from the name
 * onto the card beside it, whose own hover then keeps it open.
 */
export const PROFILE_POPOVER_CLOSE_DELAY_MS = 250;

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
  if (user.profilePublic === false || isDiscordGhost(user)) return false;
  return Boolean(user.bio?.trim() || user.title?.trim() || user.company?.trim() || hasPortfolioAnalytics(user.portfolioAnalytics));
}

function hasChatProfileDetails(user: ChatUserSummary): boolean {
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
        label: analytics.basis === "holdings" ? "1Y est." : "1Y",
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
            <Text fg={colors.textMuted}>{truncateWithEllipsis(label, labelWidth)}</Text>
            <Text fg={analyticsValueColor(metric.id, metric.rawValue)} attributes={TextAttributes.BOLD}>
              {truncateWithEllipsis(metric.value, valueWidth)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** The narrowest name-only card, so a short name still has a button to aim at. */
const NAME_CARD_MIN_WIDTH = 18;

/**
 * A name-only card's one row: the handle, then the display name where it says
 * something the handle does not.
 */
function nameCardRow(user: ChatUserSummary): { handle: string; name: string | null } {
  const displayName = user.displayName?.trim() ?? "";
  if (!user.username) return { handle: displayName, name: null };
  const same = displayName.replace(/^@+/, "").toLowerCase() === user.username.toLowerCase();
  return { handle: `@${user.username}`, name: displayName && !same ? displayName : null };
}

function nameCardNaturalWidth(user: ChatUserSummary): number {
  const { handle, name } = nameCardRow(user);
  return displayWidth(handle) + (name ? 1 + displayWidth(name) : 0);
}

function NameCardRow({ user, width }: { user: ChatUserSummary; width: number }) {
  const { handle, name } = nameCardRow(user);
  const handleText = truncateToDisplayWidth(handle, width);
  const nameWidth = width - displayWidth(handleText) - 1;
  return (
    <Box height={1} width={width} flexDirection="row">
      <Text fg={colors.positive} attributes={TextAttributes.BOLD}>{handleText}</Text>
      {name && nameWidth >= 4 ? <Text fg={colors.textDim}>{` ${truncateToDisplayWidth(name, nameWidth)}`}</Text> : null}
    </Box>
  );
}

export function UserProfilePopover({
  user,
  anchor = null,
  width,
  onClose,
  onDismiss = onClose,
  onKeepOpen,
  isOwnProfile = false,
  onSetUpProfile,
  messageAction,
  messageRefusal,
}: {
  user: ChatUserSummary;
  /**
   * The name or @mention it opened from. The desktop and the web place the
   * card just below it, or above it near the pane's foot; without one, and in
   * the terminal, it sits in the pane's top-right corner.
   */
  anchor?: ChatUserAnchor;
  width: number;
  /** The pointer left the card. */
  onClose: () => void;
  /** A click outside the card or Esc closes it, even a pinned one. */
  onDismiss?: () => void;
  /** The pointer came onto the card: it stays open while it is used. */
  onKeepOpen: () => void;
  isOwnProfile?: boolean;
  onSetUpProfile?: () => void;
  /** "Message" or "Open DM" for someone you can write to; left out for anyone else. */
  messageAction?: { label: string; onPress: () => void } | null;
  /**
   * Why someone takes no DM from you. The name-only card says it where the
   * button would be; a profile card leaves it out.
   */
  messageRefusal?: string | null;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  // The terminal card's border and padding take two cells a side; the desktop
  // popover pads itself, and its content keeps the width it always had.
  const chromeWidth = nativePaneChrome ? 2 : 4;
  const maxPopoverWidth = Math.max(24, Math.min(38, width - 4));
  // Anyone without a public profile still gets a card: the name and a way to write to them.
  const nameOnly = !isOwnProfile && !hasPublicChatProfileInfo(user);
  const popoverWidth = nameOnly
    ? Math.min(maxPopoverWidth, Math.max(
      NAME_CARD_MIN_WIDTH,
      nameCardNaturalWidth(user),
      messageRefusal ? displayWidth(messageRefusal) : 0,
    ) + chromeWidth)
    : maxPopoverWidth;
  const meta = [user.title, user.company].filter(Boolean).join(" · ");
  const bio = user.bio?.trim();
  const analytics = user.portfolioAnalytics;
  const metrics = analytics ? analyticsMetrics(analytics) : [];
  const headerWidth = Math.max(1, popoverWidth - chromeWidth);
  const maxStatsWidth = Math.max(0, headerWidth - 8);
  const statsWidth = metrics.length > 0 && maxStatsWidth >= 8
    ? Math.min(headerMetricsNaturalWidth(metrics), maxStatsWidth)
    : 0;
  const usernameWidth = Math.max(1, headerWidth - (statsWidth > 0 ? statsWidth + 1 : 0));
  const showSetupAction = shouldOfferChatProfileSetup(user, isOwnProfile) && !!onSetUpProfile;

  const content = nameOnly ? (
    <>
      <NameCardRow user={user} width={headerWidth} />
      {messageAction ? (
        <Button label={messageAction.label} width={headerWidth} variant="ghost" compact stopPropagation onPress={messageAction.onPress} />
      ) : messageRefusal ? (
        <Text fg={colors.textDim} wrapText width={headerWidth}>{messageRefusal}</Text>
      ) : null}
    </>
  ) : (
    <>
      <Box height={1} width={headerWidth} flexDirection="row">
        <Box width={usernameWidth}>
          <Text fg={colors.positive} attributes={TextAttributes.BOLD}>
            {truncateWithEllipsis(user.username ? `@${user.username}` : user.displayName, usernameWidth)}
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
      {meta ? <Text fg={colors.textDim}>{truncateWithEllipsis(meta, headerWidth)}</Text> : null}
      {bio ? (
        <Text fg={colors.text} wrapText width={headerWidth}>
          {bio}
        </Text>
      ) : null}
      {showSetupAction ? (
        <Button label="Set up profile" width={headerWidth} variant="ghost" compact stopPropagation onPress={onSetUpProfile} />
      ) : null}
      {messageAction ? (
        <Button label={messageAction.label} width={headerWidth} variant="ghost" compact stopPropagation onPress={messageAction.onPress} />
      ) : null}
    </>
  );

  if (nativePaneChrome) {
    // The kit popover, beside the name it opened from so the pointer reaches
    // it in one short move, and inside the pane. Opened with no name (the
    // keyboard on a message that is not on screen), it takes the pane's
    // top-right corner like the terminal card. It stays open while pointed at.
    return (
      <Box position="absolute" top={1} right={2} width={1} height={0}>
        <Popover
          open
          onOpenChange={(open) => { if (!open) onDismiss(); }}
          trigger={<Box width={1} height={0} />}
          anchor={anchor}
          boundary="pane"
          placement={anchor ? "bottom-start" : "bottom-end"}
          minWidth={0}
          focusOnOpen={false}
          label="User profile"
          onPointerEnter={onKeepOpen}
          onPointerLeave={onClose}
        >
          <Box flexDirection="column" width={headerWidth}>
            {content}
          </Box>
        </Popover>
      </Box>
    );
  }

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
      onMouseOver={onKeepOpen}
      onMouseMove={onKeepOpen}
      onMouseOut={onClose}
      style={{ zIndex: 4 }}
    >
      {content}
    </Box>
  );
}
