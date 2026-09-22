export const EVENT_ALERTS_KEY = "eventAlerts";
export const MAX_EVENT_ALERTS = 40;

export interface EventAlertRule {
  id: string;
  kind: "congress_trade" | "thirteenf_filing";
  target: "watched" | "member" | "fund";
  value: string;
  createdAt: number;
  status: "active" | "paused";
}

export const EVENT_ALERT_TEMPLATES = [
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
    field: "House member",
    placeholder: "Nancy Pelosi:CA11",
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
      template.target === "fund" ? "Enter a numeric SEC CIK." : "Enter a House member's full name.",
    );
  if (normalized.length > 160) throw new Error("The member name is too long.");
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
      if (
        !template ||
        typeof value.value !== "string" ||
        (value.status !== "active" && value.status !== "paused") ||
        !Number.isFinite(value.createdAt) ||
        value.createdAt <= 0
      )
        throw new Error();
      const normalized = template.normalize(value.value);
      if (template.field && !normalized) throw new Error();
      rules.push({
        id: value.id,
        kind: template.kind,
        target: template.target,
        value: normalized,
        status: value.status,
        createdAt: value.createdAt,
      });
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
  return rule.target === "watched"
    ? "Portfolio and watchlist"
    : rule.target === "fund"
      ? `CIK ${rule.value}`
      : rule.value;
}
