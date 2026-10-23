import { CATALYST_TYPES } from "../../../api-client/catalysts";
import { isResearchAlertKind, normalizeResearchRule, type ResearchAlertKind } from "./research-rules";
import { researchAlertDescription } from "./research-builder";
export const EVENT_ALERTS_KEY = "eventAlerts";
/**
 * IV level rules, kept apart from `eventAlerts`: released versions read every
 * rule there and refuse the whole list over a kind they do not know, so a rule
 * synced from a newer app would stop every event alert on a device not yet
 * updated. They never read this key.
 */
export const IV_LEVEL_ALERTS_KEY = "ivLevelAlerts";
export const MAX_EVENT_ALERTS = 40;

/** The config key a rule is kept under. */
export const eventAlertStoreKey = (rule: Pick<EventAlertRule, "kind">) =>
  rule.kind === "iv_level" ? IV_LEVEL_ALERTS_KEY : EVENT_ALERTS_KEY;

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
  /**
   * IV level: when the level was reached. The rule stays Alerted until it is
   * re-armed. Its readings stay on the device (`ivLevelChecks`), so synced
   * config changes only when a rule goes off or is edited.
   */
  triggeredAt?: number;
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

/** A saved list of event alerts: the rules this version reads, and the ones of kinds it does not know. */
export interface EventAlertList {
  rules: EventAlertRule[];
  error: string | null;
  /**
   * Saved rules of kinds this version does not know (a newer app's), as they
   * were saved: they are left out of every list and check, and written back
   * unchanged with the rest.
   */
  kept: unknown[];
}

/** A kind this version reads: a template's, or a research rule's. */
const isKnownEventAlertKind = (kind: string) =>
  EVENT_ALERT_TEMPLATES.some((template) => template.kind === kind) || isResearchAlertKind(kind);

export function readEventAlerts(json: string): EventAlertList {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error();
    const rules: EventAlertRule[] = [];
    const kept: unknown[] = [];
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
      // A newer app's kind is kept as it is, so it neither stops this list nor is lost when it is saved.
      if (typeof value.kind === "string" && !isKnownEventAlertKind(value.kind)) {
        kept.push(value);
        ids.add(value.id);
        continue;
      }
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
      if (rule.kind === "iv_level" && Number.isFinite(value.triggeredAt) && value.triggeredAt > 0) rule.triggeredAt = value.triggeredAt;
      rules.push(rule);
      ids.add(value.id);
    }
    return { rules, error: null, kept };
  } catch {
    // Intentional ignore: invalid saved rules return the error displayed by callers.
    return { rules: [], error: "Saved event alerts could not be read.", kept: [] };
  }
}

/** A list as it is saved: its rules, then the ones of kinds this version does not know, unchanged. */
export function writeEventAlerts(rules: readonly EventAlertRule[], kept: readonly unknown[] = []): string {
  return JSON.stringify([...rules, ...kept]);
}

/** A saved list with `update` applied to its rules; a list that does not read is left as it is. */
export function updateEventAlerts(json: string | null | undefined, update: (rules: EventAlertRule[]) => EventAlertRule[]): string {
  const current = json ?? "[]";
  const list = readEventAlerts(current);
  return list.error ? current : writeEventAlerts(update(list.rules), list.kept);
}

/** Both saved lists, read through `get`: the rules of each, together, and each list as read. */
export function readEventAlertStores(get: (key: string) => unknown): {
  rules: EventAlertRule[];
  error: string | null;
  lists: Record<typeof EVENT_ALERTS_KEY | typeof IV_LEVEL_ALERTS_KEY, EventAlertList>;
} {
  const read = (key: string) => {
    const raw = get(key);
    return readEventAlerts(typeof raw === "string" && raw ? raw : "[]");
  };
  const lists = { [EVENT_ALERTS_KEY]: read(EVENT_ALERTS_KEY), [IV_LEVEL_ALERTS_KEY]: read(IV_LEVEL_ALERTS_KEY) };
  const all = Object.values(lists);
  return { rules: all.flatMap((list) => list.rules), error: all.find((list) => list.error)?.error ?? null, lists };
}

/**
 * `rules` saved back to the lists they belong in, each keeping what it held of
 * kinds this version does not know. Only a list that changes is returned.
 */
export function writeEventAlertStores(
  lists: ReturnType<typeof readEventAlertStores>["lists"],
  rules: readonly EventAlertRule[],
): Record<string, string> {
  const written: Record<string, string> = {};
  for (const [key, list] of Object.entries(lists)) {
    // A list that does not read is never written over.
    if (list.error) continue;
    const own = rules.filter((rule) => eventAlertStoreKey(rule) === key);
    const before = list.rules;
    const same = own.length === before.length && own.every((rule, index) => rule === before[index]);
    if (!same) written[key] = writeEventAlerts(own, list.kept);
  }
  return written;
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
