import type { AssistCommandCandidate } from "../../../api-client";
import { t, tf } from "../../../i18n";
import type { ResultItem } from "../list/model";

/** Marker shown on every AI-resolved row, matching the AI plugin's iconography. */
const ASSIST_GLYPH = "✦";

/** Category heading the assist rows group under; sorted last by the view model. */
const ASSIST_CATEGORY = "Ask AI";

export type AssistErrorKind = "unavailable" | "rate-limited" | "failed";

export type AssistRequestState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "answered"; query: string; candidates: AssistCommandCandidate[] }
  | { status: "error"; query: string; kind: AssistErrorKind };

export interface AssistRowHandlers {
  /** Signed in with a verified email, i.e. `/assist/command` will answer. */
  enabled: boolean;
  state: AssistRequestState;
  onAsk: () => void;
  onSignUp: () => void;
  onRunCandidate: (input: string) => void;
}

/**
 * Whether the root list should offer the AI a shot at the query. Multi-word
 * input reads as natural language rather than a prefix, and a query with no
 * local matches is a dead end either way.
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
  action?: () => void;
}): ResultItem {
  return {
    id: options.id,
    label: `${ASSIST_GLYPH} ${options.label}`,
    detail: "",
    category: ASSIST_CATEGORY,
    kind: options.kind,
    disabled: !options.action,
    action: options.action ?? (() => {}),
  };
}

/**
 * Rows for the assist section. The request is only ever started by activating
 * the entry row, so an untouched query renders a single call-to-action; the
 * response then replaces that row in place, keeping the selection index put.
 */
export function buildAssistResultItems({
  query,
  enabled,
  state,
  onAsk,
  onSignUp,
  onRunCandidate,
}: AssistRowHandlers & { query: string }): ResultItem[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (!enabled) {
    return [assistRow({
      id: "assist:sign-up",
      label: t("Ask AI — sign up to enable"),
      kind: "action",
      action: onSignUp,
    })];
  }

  // A response only describes the query it was asked about.
  const active = state.status !== "idle" && state.query === trimmed ? state : null;

  if (active?.status === "loading") {
    return [assistRow({ id: "assist:loading", label: t("Thinking…"), kind: "info" })];
  }

  if (active?.status === "error") {
    return [assistRow({
      id: "assist:error",
      label: assistErrorLabel(active.kind),
      kind: "info",
      action: onAsk,
    })];
  }

  if (active?.status === "answered") {
    if (active.candidates.length === 0) {
      return [assistRow({
        id: "assist:no-command",
        label: t("No command found — try HELP"),
        kind: "info",
      })];
    }
    // Input first: the row doubles as a lesson in the prefix language.
    return active.candidates.map((candidate, index) => assistRow({
      id: `assist:candidate:${index}:${candidate.input}`,
      label: `${candidate.input} — ${candidate.title}`,
      kind: "action",
      action: () => onRunCandidate(candidate.input),
    }));
  }

  return [assistRow({
    id: "assist:ask",
    label: tf('Ask AI: "{query}"', { query: trimmed }),
    kind: "action",
    action: onAsk,
  })];
}
