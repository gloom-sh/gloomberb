import type { ReactNode } from "react";
import { t, tf } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text } from "../../ui";
import { Spinner } from "./loading";

export interface EmptyStateProps {
  title: string;
  message?: string;
  hint?: string;
  actions?: ReactNode;
  status?: "empty" | "error";
}

export function EmptyState({ title, message, hint, actions, status = "empty" }: EmptyStateProps) {
  const colors = useThemeColors();
  // Provider messages must wrap at narrow pane widths rather than lose their tail.
  return (
    <Box flexDirection="column" data-gloom-status={status} data-gloom-ui="empty-state">
      <Box><Text fg={status === "error" ? colors.negative : colors.textDim} wrapText>{t(title)}</Text></Box>
      {message && <Box><Text fg={colors.textMuted} wrapText>{t(message)}</Text></Box>}
      {hint && <Box><Text fg={colors.textMuted} wrapText>{t(hint)}</Text></Box>}
      {actions && <Box flexDirection="row" gap={1} marginTop={1}>{actions}</Box>}
    </Box>
  );
}

export interface NoticeProps {
  children: ReactNode;
  tone?: "muted" | "positive" | "warning" | "negative";
}

/** Inline feedback leaves existing content visible, including stale data after a refresh failure. */
export function Notice({ children, tone = "warning" }: NoticeProps) {
  const colors = useThemeColors();
  return (
    <Box data-gloom-status={tone === "negative" ? "error" : "notice"} data-gloom-ui="notice">
      <Text fg={tone === "muted" ? colors.textDim : colors[tone]} wrapText>{children}</Text>
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
  subject?: string;
  loadingLabel?: string;
  errorTitle?: string;
  emptyTitle?: string;
  emptyMessage?: string;
  actions?: ReactNode;
  align?: "start" | "center";
  width?: number;
  height?: number;
  children?: ReactNode;
}

/** State precedence remains explicit at the caller: pass loading/error only when replacing the body. */
export function PaneStatusBody({
  loading = false,
  error,
  empty = false,
  subject,
  loadingLabel,
  errorTitle,
  emptyTitle,
  emptyMessage,
  actions,
  align = "start",
  width,
  height,
  children,
}: PaneStatusBodyProps) {
  const status = error ? "error" : loading ? "loading" : empty ? "empty" : null;
  if (!status) return <>{children}</>;
  return (
    <Box
      width={width}
      height={height}
      flexGrow={align === "center" ? 1 : undefined}
      paddingX={1}
      paddingY={1}
      alignItems={align === "center" ? "center" : undefined}
      justifyContent={align === "center" ? "center" : undefined}
      data-gloom-status={status}
      data-gloom-ui="pane-status"
    >
      {status === "loading" ? <Spinner label={loadingLabel ?? loadingText(subject)} /> : (
        <EmptyState
          status={status}
          title={status === "error" ? errorTitle ?? (subject ? unavailableText(subject) : error!) : emptyTitle ?? t("Nothing to show yet.")}
          message={status === "error" ? (errorTitle || subject ? error! : undefined) : emptyMessage}
          actions={actions}
        />
      )}
    </Box>
  );
}
