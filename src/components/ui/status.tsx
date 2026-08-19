import type { ReactNode } from "react";
import { Box, Text } from "../../ui";
import { colors } from "../../theme/colors";
import { t, tf } from "../../i18n";

export interface EmptyStateProps {
  title: string;
  message?: string;
  hint?: string;
}

export function EmptyState({ title, message, hint }: EmptyStateProps) {
  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text fg={colors.textDim}>{t(title)}</Text>
      </Box>
      {message && (
        <Box height={1}>
          <Text fg={colors.textMuted}>{t(message)}</Text>
        </Box>
      )}
      {hint && (
        <Box height={1}>
          <Text fg={colors.textMuted}>{t(hint)}</Text>
        </Box>
      )}
    </Box>
  );
}

/** The one loading phrasing: "Loading ..." with three dots, never the ellipsis glyph. */
export function loadingText(thing?: string): string {
  return thing ? tf("Loading {thing}...", { thing }) : t("Loading...");
}

/** The one failure phrasing: "<Thing> unavailable." */
export function unavailableText(thing: string): string {
  return tf("{thing} unavailable.", { thing });
}

export interface PaneStatusBodyProps {
  loading?: boolean;
  error?: string | null;
  /** True when there is nothing to show and nothing is in flight. */
  empty?: boolean;
  /** Names what is being loaded or what failed, e.g. "movers". */
  subject?: string;
  emptyTitle?: string;
  emptyMessage?: string;
  children?: ReactNode;
}

/**
 * Standard loading/error/empty body for a pane. Returns `children` once there
 * is something to render, so a pane can wrap its content in one place instead
 * of hand-rolling three near-identical states.
 */
export function PaneStatusBody({
  loading = false,
  error,
  empty = false,
  subject,
  emptyTitle,
  emptyMessage,
  children,
}: PaneStatusBodyProps) {
  if (error) {
    return (
      <Box paddingX={1} paddingY={1}>
        <EmptyState
          title={subject ? unavailableText(subject) : error}
          message={subject ? error : undefined}
        />
      </Box>
    );
  }
  if (loading) {
    // The screenshot renderer waits on this marker to know a pane is still
    // fetching. It must be a real attribute, never a word match on body text.
    return (
      <Box paddingX={1} paddingY={1} data-gloom-status="loading">
        <EmptyState title={loadingText(subject)} />
      </Box>
    );
  }
  if (empty) {
    return (
      <Box paddingX={1} paddingY={1}>
        <EmptyState
          title={emptyTitle ?? t("Nothing to show yet.")}
          message={emptyMessage}
        />
      </Box>
    );
  }
  return <>{children}</>;
}
