import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { t, tf } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../ui";
import { formatRelativeAge } from "../../utils/datetime-format";
import { Spinner } from "./loading";
import { ButtonActionScope } from "./action-scope";
import { Button } from "./button";

/**
 * Asking again from an empty or failed state. The state draws the button
 * (first, so it answers Enter), keeps it busy while the check runs, and when
 * the answer comes back the same, says when it checked: otherwise a press that
 * changes nothing on screen looks like a press that did nothing.
 */
export interface StatusRetry {
  /** Asks again. A returned promise keeps the button busy until it settles. */
  onRetry: () => unknown;
  /** "Retry", unless the check has a better verb, such as "Look again". */
  label?: string;
  /** The label while it runs: "Retrying..." for the default label. */
  pendingLabel?: string;
  /**
   * The same check running from anywhere (the button, `r`, a timer), such as
   * a resource's `loading`. Needed when the old answer stays on screen while
   * it runs, as an uncovered company does.
   */
  pending?: boolean;
  /** Said after "Checked just now." when an empty state comes back the same, such as "Still no careers system." */
  unchanged?: string;
}

export interface EmptyStateProps {
  title: string;
  message?: string;
  hint?: string;
  actions?: ReactNode;
  retry?: StatusRetry;
  status?: "empty" | "error";
}

type ShownStatus = "empty" | "error" | null;

interface RetryFeedback {
  pending: boolean;
  press: () => void;
  /** When a check ended on the state it started from; null once anything else is shown. */
  checkedAt: number | null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

/**
 * A check is the button's own promise, `retry.pending`, or the body showing
 * its spinner (`shown === "loading"`) once a retry has been offered. When one
 * ends on the empty or failed state it started from, the answer did not change.
 */
function useRetryFeedback(retry: StatusRetry | undefined, shown: ShownStatus | "loading"): RetryFeedback {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const inFlight = useRef(0);
  const mounted = useRef(true);
  const track = useRef<{ offered: boolean; checking: boolean; from: ShownStatus; last: ShownStatus }>({
    offered: false, checking: false, from: null, last: null,
  });
  if (retry) track.current.offered = true;
  const pending = inFlight.current > 0 || retry?.pending === true;
  const checking = pending || shown === "loading";
  const begin = () => {
    const state = track.current;
    if (state.checking) return;
    state.checking = true;
    state.from = state.last;
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // After every commit: a check that just ended either confirms the state on
  // screen or clears the line, and anything else shown clears it. A body that
  // never offered a retry skips all of it.
  useEffect(() => {
    const state = track.current;
    if (!state.offered) return;
    if (checking) {
      begin();
      return;
    }
    // `shown` is not "loading" here: that counts as checking.
    if (state.checking) {
      state.checking = false;
      setCheckedAt(shown !== null && shown === state.from ? Date.now() : null);
    } else if (shown !== state.last) {
      setCheckedAt(null);
    }
    state.last = shown;
  });

  // "just now" turns into "2m ago" while the line stays up.
  const shownCheckedAt = checking ? null : checkedAt;
  useEffect(() => {
    if (shownCheckedAt === null) return;
    const timer = setInterval(rerender, 30_000);
    return () => clearInterval(timer);
  }, [shownCheckedAt]);

  const press = () => {
    if (!retry || pending) return;
    const result = retry.onRetry();
    if (!isThenable(result)) return;
    begin();
    inFlight.current += 1;
    rerender();
    const done = () => {
      inFlight.current -= 1;
      if (mounted.current) rerender();
    };
    result.then(done, done);
  };

  return { pending, press, checkedAt: shownCheckedAt };
}

function retryNote(retry: StatusRetry, status: "empty" | "error", checkedAt: number): string {
  const age = formatRelativeAge(checkedAt, Math.max(checkedAt, Date.now()));
  if (status === "error") return tf("Tried again {age}.", { age });
  const checked = tf("Checked {age}.", { age });
  return retry.unchanged ? `${checked} ${t(retry.unchanged)}` : checked;
}

export function EmptyState(props: EmptyStateProps) {
  const feedback = useRetryFeedback(props.retry, props.retry ? props.status ?? "empty" : null);
  return <EmptyStateBody {...props} feedback={feedback} />;
}

function EmptyStateBody({ title, message, hint, actions, retry, status = "empty", feedback }: EmptyStateProps & { feedback: RetryFeedback }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const retryButton = retry ? (
    <Button
      label={retry.label ?? "Retry"}
      pendingLabel={retry.pendingLabel ?? (retry.label ? undefined : "Retrying...")}
      pending={feedback.pending}
      onPress={feedback.press}
    />
  ) : null;
  // Provider messages must wrap at narrow pane widths rather than lose their tail.
  return (
    <Box flexDirection="column" data-gloom-status={status} data-gloom-ui="empty-state">
      <Box><Text fg={status === "error" ? colors.negative : colors.textDim} wrapText>{t(title)}</Text></Box>
      {message && <Box><Text fg={colors.textMuted} wrapText>{t(message)}</Text></Box>}
      {hint && <Box><Text fg={colors.textMuted} wrapText>{t(hint)}</Text></Box>}
      {/* Wraps in a narrow pane rather than clipping the second action; a terminal wraps without a blank row. */}
      {(retryButton || actions) && (
        <Box flexDirection="row" flexWrap="wrap" gap={1} rowGap={nativePaneChrome ? undefined : 0} marginTop={1}>
          <ButtonActionScope>{retryButton}{actions}</ButtonActionScope>
        </Box>
      )}
      {retry && feedback.checkedAt !== null && (
        <Box><Text fg={colors.textMuted} wrapText>{retryNote(retry, status, feedback.checkedAt)}</Text></Box>
      )}
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
  /** Asking again from the error or empty state; see StatusRetry. */
  retry?: StatusRetry;
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
  retry,
  align = "start",
  width,
  height,
  children,
}: PaneStatusBodyProps) {
  const status = error ? "error" : loading ? "loading" : empty ? "empty" : null;
  // Here rather than in the state, so a retry that shows the spinner while it
  // runs still says it tried once the same failure is back.
  const feedback = useRetryFeedback(retry, status);
  if (!status) return <>{children}</>;
  // Keyed so content that starts with a bare Box never reuses this padded node.
  return (
    <Box
      key="pane-status"
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
        <EmptyStateBody
          status={status}
          title={status === "error" ? errorTitle ?? (subject ? unavailableText(subject) : error!) : emptyTitle ?? t("Nothing to show yet.")}
          message={status === "error"
            ? ((errorTitle || subject) && error && error !== (errorTitle ?? unavailableText(subject!)) ? error : undefined)
            : emptyMessage}
          actions={actions}
          retry={retry}
          feedback={feedback}
        />
      )}
    </Box>
  );
}
