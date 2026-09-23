import { apiClient } from "../../../api-client";
import { formatPremium, RESEARCH_LABELS } from "./research-builder";
import { isResearchAlertKind } from "./research-rules";

export interface AlertHistoryItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  deliveredAt: string;
}
/** Latest source observation behind one research rule, with its percentile context. */
export interface AlertRuleState {
  ruleId: string;
  asOf: string | null;
  conditionMet: boolean | null;
  value: number | null;
  unit: string | null;
  percentile: number | null;
  samples: number;
  warning: string | null;
  checkedAt: string;
}
export interface AlertHistory {
  status: "ready" | "unavailable";
  warning: string | null;
  asOf: string;
  items: AlertHistoryItem[];
  states: AlertRuleState[];
  hasMore: boolean;
  nextOffset: number | null;
  deviceEnabled: boolean;
  syncAsOf: string | null;
}

const KIND_LABELS: Record<string, string> = {
  price: "Price",
  breaking_news: "Breaking news",
  earnings: "Earnings",
  chat: "Chat",
  thesis: "Thesis",
  congress_trade: "Congress",
  thirteenf_filing: "13F filing",
};
export const alertKindLabel = (kind: string) =>
  isResearchAlertKind(kind) ? RESEARCH_LABELS[kind] : (KIND_LABELS[kind] ?? kind.replaceAll("_", " "));

const dated = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
export function validateAlertHistory(value: unknown): AlertHistory {
  const data = value as AlertHistory;
  if (
    !data ||
    (data.status !== "ready" && data.status !== "unavailable") ||
    !Array.isArray(data.items) ||
    !Array.isArray(data.states) ||
    data.items.some((item) => !item || typeof item.title !== "string" || typeof item.kind !== "string" || !dated(item.deliveredAt)) ||
    data.states.some((state) => !state || typeof state.ruleId !== "string" || (state.asOf !== null && !dated(state.asOf)))
  )
    throw new Error("Invalid alert history from Gloom Cloud.");
  return data;
}
export async function fetchAlertHistory(offset = 0) {
  return validateAlertHistory(await apiClient.getMobileAlertHistory<unknown>(offset));
}

/** "1.84 x prior 20-session volume · 97 pctl · 2026-09-21", or why there is no reading. */
export function ruleStateText(state: AlertRuleState | undefined): string {
  if (!state) return "--";
  if (state.value == null || !state.asOf) return state.warning ?? "Waiting for a source observation";
  // Options flow keeps its latest matching print: premium and when it traded.
  if (state.unit === "USD") {
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(state.asOf));
    return `last ${formatPremium(state.value)} print \u00b7 ${state.asOf.slice(0, 10)} ${time} ET`;
  }
  const value = Math.abs(state.value) >= 100 ? state.value.toFixed(0) : state.value.toFixed(2);
  return [
    `${value}${state.unit ? ` ${state.unit}` : ""}`,
    state.percentile == null ? null : `${Math.round(state.percentile)} pctl`,
    state.asOf.slice(0, 10),
  ].filter(Boolean).join(" \u00b7 ");
}
