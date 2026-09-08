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
  /**
   * Opens the assistant pane with the typed question. Omitted when the ASKG
   * pane is unavailable, which keeps the row out of the list entirely.
   */
  onAskGloom?: (query: string) => void;
}

/** Prefix the assistant pane is reached by, shown in the row's badge column. */
const ASKG_PREFIX = "ASKG";

const QUESTION_WORDS = new Set([
  "what", "whats", "why", "how", "when", "where", "who", "which", "whose",
  "is", "are", "was", "were", "do", "does", "did", "can", "could", "should",
  "would", "will", "has", "have", "explain", "compare", "summarize", "summarise",
]);

/**
 * Whether the text reads as a question rather than a command. A question mark
 * settles it; otherwise a leading question word only counts in a phrase, so
 * "is" on its own stays a prefix search.
 */
export function isQuestionLike(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("?")) return true;
  if (!/\s/.test(trimmed)) return false;
  const first = trimmed.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return QUESTION_WORDS.has(first);
}

/**
 * Whether the assistant pane is worth offering: the user asked a question, or
 * the command translation came back without a command that fits.
 */
export function shouldOfferAskGloom({
  query,
  state,
}: {
  query: string;
  state: AssistRequestState;
}): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  if (isQuestionLike(trimmed)) return true;
  return state.status === "answered"
    && state.query === trimmed
    && state.candidates.length === 0;
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
  onAskGloom,
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

  const askGloomRow = (defaultSelectable: boolean): ResultItem | null => (
    onAskGloom && shouldOfferAskGloom({ query: trimmed, state })
      ? assistRow({
        id: "assist:ask-gloom",
        label: `${trimmed} · ${t("Ask Gloom")}`,
        badge: ASKG_PREFIX,
        kind: "action",
        action: () => onAskGloom(trimmed),
        defaultSelectable,
      })
      : null
  );

  if (!active) {
    const askGloom = askGloomRow(false);
    if (!auto) return askGloom ? [askGloom] : [];
    // Still inside the debounce window; activating the row skips the wait.
    const pending = assistRow({ id: "assist:pending", label: t("Thinking…"), kind: "info", action: onAsk });
    return askGloom ? [pending, askGloom] : [pending];
  }

  if (active.status === "loading") {
    // Selectable so that Enter on it means something: it claims the answer
    // that is already on the wire.
    const loading = assistRow({ id: "assist:loading", label: t("Thinking…"), kind: "info", action: onAsk });
    const askGloom = askGloomRow(false);
    return askGloom ? [loading, askGloom] : [loading];
  }

  if (active.status === "error") {
    // The assistant pane does not depend on the command translation, so a
    // failed translation still leaves the question answerable.
    const askGloom = askGloomRow(true);
    // A background failure is not worth a row the user never asked for.
    if (active.source === "auto") return askGloom ? [askGloom] : [];
    const error = assistRow({
      id: "assist:error",
      label: assistErrorLabel(active.kind),
      kind: "info",
      action: onAsk,
      defaultSelectable: false,
    });
    return askGloom ? [error, askGloom] : [error];
  }

  if (active.candidates.length === 0) {
    // Nothing local fits, so the assistant is the answer rather than a dead end.
    const askGloom = askGloomRow(true);
    if (askGloom) return [askGloom];
    return [assistRow({
      id: "assist:no-command",
      label: t("No command found — try HELP"),
      kind: "info",
    })];
  }

  // The prefix in the badge column and the argument leading the label: the
  // row doubles as a lesson in the prefix language, laid out like every
  // other row.
  const candidateRows = active.candidates.map((candidate, index) => assistRow({
    id: `assist:candidate:${index}:${candidate.input}`,
    label: formatAssistCandidateLabel(candidate),
    badge: candidate.prefix.trim() || undefined,
    kind: "action",
    action: () => onRunCandidate(candidate.input, candidate.prefix),
  }));
  // A resolved command is the faster answer, so it keeps the default selection.
  const askGloom = askGloomRow(false);
  return askGloom ? [...candidateRows, askGloom] : candidateRows;
}
