import type { AssistCommandCandidate } from "../../../api-client";
import { t } from "../../../i18n";
import type { ResultItem } from "../list/model";

/** Marker shown on every AI-resolved row, matching the AI plugin's iconography. */
const ASSIST_GLYPH = "✦";

/** Category heading the assist rows group under; the view model sorts it first. */
const ASSIST_CATEGORY = "Ask AI";

/** Shorter queries are almost always a half-typed prefix, not a question. */
const ASSIST_AUTO_MIN_QUERY_LENGTH = 3;

export type AssistErrorKind = "unavailable" | "rate-limited" | "failed";

/** Whether the request was started by the debounce or by the user hitting Enter. */
export type AssistRequestSource = "auto" | "explicit";

export type AssistRequestState =
  | { status: "idle" }
  | { status: "loading"; query: string; source: AssistRequestSource }
  | { status: "answered"; query: string; source: AssistRequestSource; candidates: AssistCommandCandidate[] }
  | { status: "error"; query: string; source: AssistRequestSource; kind: AssistErrorKind };

export interface AssistRowHandlers {
  /** Signed in with a verified email, i.e. `/assist/command` will answer. */
  enabled: boolean;
  /** The query qualifies for a background ask, so the section is expected. */
  auto: boolean;
  state: AssistRequestState;
  onAsk: () => void;
  onSignUp: () => void;
  onRunCandidate: (input: string, prefix?: string) => void;
}

/**
 * Whether the query should be answered by the AI without being asked for it.
 * Anything the prefix parser recognizes is the user speaking the command
 * language, and very short input is a prefix mid-typing rather than a question.
 */
export function shouldAutoAskAssist({
  query,
  hasShortcutIntent,
}: {
  query: string;
  hasShortcutIntent: boolean;
}): boolean {
  if (hasShortcutIntent) return false;
  return query.trim().length >= ASSIST_AUTO_MIN_QUERY_LENGTH;
}

/**
 * Whether a signed-out user is offered the sign-up row. Multi-word input reads
 * as natural language rather than a prefix, and a query with no local matches
 * is a dead end either way.
 */
export function shouldShowAssistRow({
  query,
  resultCount,
}: {
  query: string;
  resultCount: number;
}): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed)) return true;
  return resultCount === 0;
}

function assistErrorLabel(kind: AssistErrorKind): string {
  if (kind === "unavailable") return t("AI assist unavailable");
  if (kind === "rate-limited") return t("Rate limited — try again in a minute");
  return t("AI assist failed — try again");
}

function assistRow(options: {
  id: string;
  label: string;
  kind: ResultItem["kind"];
  badge?: string;
  action?: () => void;
  defaultSelectable?: boolean;
}): ResultItem {
  return {
    id: options.id,
    label: options.label,
    detail: "",
    category: ASSIST_CATEGORY,
    kind: options.kind,
    badge: options.badge,
    // Right-aligned like a shortcut, so the glyph never crowds the answer.
    right: ASSIST_GLYPH,
    accent: true,
    disabled: !options.action,
    defaultSelectable: options.defaultSelectable,
    action: options.action ?? (() => {}),
  };
}

/**
 * Label for a resolved command, read like every other row: the argument leads
 * and the description follows, while the prefix moves to the badge column.
 * "DES NVDA" titled "Open security details for NVDA" reads
 * "NVDA · Open security details".
 */
export function formatAssistCandidateLabel(candidate: Pick<AssistCommandCandidate, "input" | "prefix" | "title">): string {
  const input = candidate.input.trim();
  const prefix = candidate.prefix.trim();
  const argument = prefix && input.toUpperCase().startsWith(`${prefix.toUpperCase()} `)
    ? input.slice(prefix.length).trim()
    : prefix && input.toUpperCase() === prefix.toUpperCase()
      ? ""
      : input;
  // The title usually ends by naming the argument again ("... for NVDA").
  let title = candidate.title.trim();
  for (const connective of ["for", "of"]) {
    const suffix = ` ${connective} ${argument}`.toLowerCase();
    if (argument && title.toLowerCase().endsWith(suffix)) {
      title = title.slice(0, -suffix.length).trim();
      break;
    }
  }
  return [argument, title].filter(Boolean).join(" \u00b7 ");
}

/**
 * Rows for the assist section. They always land in their own category, which
 * sorts to the top of the list: the AI turns the sentence the user typed into
 * commands, so its answer leads the results.
 */
export function buildAssistResultItems({
  query,
  enabled,
  auto,
  state,
  onAsk,
  onSignUp,
  onRunCandidate,
}: AssistRowHandlers & { query: string }): ResultItem[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (!enabled) {
    // An offer, not an answer: it never takes the Enter that belongs to the
    // local match the user is looking at.
    return [assistRow({
      id: "assist:sign-up",
      label: t("Ask AI — sign up to enable"),
      kind: "action",
      action: onSignUp,
      defaultSelectable: false,
    })];
  }

  // A response only describes the query it was asked about.
  const active = state.status !== "idle" && state.query === trimmed ? state : null;

  if (!active) {
    if (!auto) return [];
    // Still inside the debounce window; activating the row skips the wait.
    return [assistRow({ id: "assist:pending", label: t("Thinking…"), kind: "info", action: onAsk })];
  }

  if (active.status === "loading") {
    // Selectable so that Enter on it means something: it claims the answer
    // that is already on the wire.
    return [assistRow({ id: "assist:loading", label: t("Thinking…"), kind: "info", action: onAsk })];
  }

  if (active.status === "error") {
    // A background failure is not worth a row the user never asked for.
    if (active.source === "auto") return [];
    return [assistRow({
      id: "assist:error",
      label: assistErrorLabel(active.kind),
      kind: "info",
      action: onAsk,
      defaultSelectable: false,
    })];
  }

  if (active.candidates.length === 0) {
    return [assistRow({
      id: "assist:no-command",
      label: t("No command found — try HELP"),
      kind: "info",
    })];
  }

  // The prefix in the badge column and the argument leading the label: the
  // row doubles as a lesson in the prefix language, laid out like every
  // other row.
  return active.candidates.map((candidate, index) => assistRow({
    id: `assist:candidate:${index}:${candidate.input}`,
    label: formatAssistCandidateLabel(candidate),
    badge: candidate.prefix.trim() || undefined,
    kind: "action",
    action: () => onRunCandidate(candidate.input, candidate.prefix),
  }));
}
