import { CATALYST_TYPES } from "../../../api-client/catalysts";
import { isResearchAlertKind, normalizeResearchRule, type ResearchAlertKind } from "./research-rules";
import { researchAlertDescription } from "./research-builder";
export const EVENT_ALERTS_KEY = "eventAlerts";
export const MAX_EVENT_ALERTS = 40;

export interface EventAlertRule {
  id: string;
  kind: "congress_trade" | "thirteenf_filing" | "catalyst" | ResearchAlertKind;
  target: "watched" | "member" | "fund" | "rule" | "ticker" | "type" | "agency" | "country";
  value: string;
  createdAt: number;
  status: "active" | "paused";
  /**
   * Scheduled events (earnings, a macro release): the date of the next one
   * (YYYY-MM-DD), as last looked up, so a list can show it without a request.
   */
  eventDate?: string;
  /** Scheduled events: the event date it already alerted for. The next event date arms it again. */
  firedFor?: string;
}

const isDateKey = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

/** Earnings and macro event rules: they follow a dated event and alert a number of days before it. */
export function isScheduledEventRule(rule: Pick<EventAlertRule, "kind">): boolean {
  return rule.kind === "earnings_date" || rule.kind === "macro_event";
}

export const EVENT_ALERT_TEMPLATES = [
  { id: "catalyst-watched", kind: "catalyst", target: "watched", label: "Catalyst: portfolio and watchlists", field: null, placeholder: "", normalize: (_value: string) => "" },
  { id: "catalyst-ticker", kind: "catalyst", target: "ticker", label: "Catalyst: company", field: "Ticker", placeholder: "PFE or NOVN:SIX", normalize: (value: string) => /^[A-Z0-9][A-Z0-9.^:/-]{0,39}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : "" },
  { id: "catalyst-type", kind: "catalyst", target: "type", label: "Catalyst: event type", field: "Event type", placeholder: "clinical, antitrust, litigation, sanctions", normalize: (value: string) => CATALYST_TYPES.includes(value.trim().toLowerCase() as typeof CATALYST_TYPES[number]) ? value.trim().toLowerCase() : "" },
  { id: "catalyst-agency", kind: "catalyst", target: "agency", label: "Catalyst: agency", field: "Agency", placeholder: "FDA, EMA, SEC", normalize: (value: string) => value.trim().length <= 80 ? value.trim() : "" },
  { id: "catalyst-country", kind: "catalyst", target: "country", label: "Catalyst: country", field: "Country code", placeholder: "US, EU, GB", normalize: (value: string) => /^[A-Z]{2}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : "" },
  {
    id: "congress-watched",
    kind: "congress_trade",
    target: "watched",
    label: "Congress: portfolio and watchlist",
    field: null,
    placeholder: "",
    normalize: (_value: string) => "",
  },
  {
    id: "congress-member",
    kind: "congress_trade",
    target: "member",
    label: "Congress: follow a member",
    field: "Member of Congress",
    placeholder: "Nancy Pelosi or Tommy Tuberville",
    normalize: (value: string) => value.trim(),
  },
  {
    id: "thirteenf-fund",
    kind: "thirteenf_filing",
    target: "fund",
    label: "13F: follow a fund",
    field: "Fund CIK",
    placeholder: "1067983",
    normalize: (value: string) =>
      /^\d{1,10}$/.test(value.trim()) && Number(value) > 0 ? value.trim().padStart(10, "0") : "",
  },
] as const;

export function createEventAlert(
  templateId: string,
  value: string,
  now = Date.now(),
): EventAlertRule {
  const template = EVENT_ALERT_TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) throw new Error("Choose an event type.");
  const normalized = template.normalize(value);
  if (template.field && !normalized)
    throw new Error(
      template.kind === "catalyst" ? "Enter a valid catalyst target." : template.target === "fund" ? "Enter a numeric SEC CIK." : "Enter the member's first and last name.",
    );
  if (normalized.length > 160) throw new Error("The alert target is too long.");
  return {
    id: crypto.randomUUID(),
    kind: template.kind,
    target: template.target,
    value: normalized,
    createdAt: now,
    status: "active",
  };
}

export function readEventAlerts(json: string): { rules: EventAlertRule[]; error: string | null } {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error();
    const rules: EventAlertRule[] = [];
    const ids = new Set<string>();
    for (const value of parsed) {
      if (
        value == null ||
        typeof value !== "object" ||
        typeof value.id !== "string" ||
        !value.id ||
        ids.has(value.id)
      )
        throw new Error();
      const template = EVENT_ALERT_TEMPLATES.find(
        (entry) => entry.kind === value.kind && entry.target === value.target,
      );
      const research = isResearchAlertKind(value.kind) && value.target === "rule";
      if (
        (!template && !research) ||
        typeof value.value !== "string" ||
        (value.status !== "active" && value.status !== "paused") ||
        !Number.isFinite(value.createdAt) ||
        !Number.isFinite(new Date(value.createdAt).getTime()) ||
        value.createdAt <= 0
      )
        throw new Error();
      const normalized = research ? normalizeResearchRule(value.kind, value.value) : template!.normalize(value.value);
      if (normalized == null || (template?.field && !normalized)) throw new Error();
      const rule: EventAlertRule = {
        id: value.id,
        kind: value.kind,
        target: value.target,
        value: normalized,
        status: value.status,
        createdAt: value.createdAt,
      };
      // A date that does not read is dropped, not the rule: the next lookup puts it back.
      if (isScheduledEventRule(rule)) {
        if (isDateKey(value.eventDate)) rule.eventDate = value.eventDate;
        if (isDateKey(value.firedFor)) rule.firedFor = value.firedFor;
      }
      rules.push(rule);
      ids.add(value.id);
    }
    return { rules, error: null };
  } catch {
    return { rules: [], error: "Saved event alerts could not be read." };
  }
}

export function toggleEventAlert(rule: EventAlertRule, now = Date.now()): EventAlertRule {
  return {
    ...rule,
    status: rule.status === "active" ? "paused" : "active",
    createdAt: rule.status === "paused" ? now : rule.createdAt,
  };
}

export function eventAlertTarget(rule: EventAlertRule): string {
  if (rule.target === "rule") return researchAlertDescription(rule);
  return rule.target === "watched"
    ? "Portfolio and watchlist"
    : rule.target === "fund"
      ? `CIK ${rule.value}`
      : rule.value;
}
