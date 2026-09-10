import { apiClient } from "./index";
import { getCurrentPluginTarget } from "../plugins/current-target";

export type ResearchActivity =
  | "workspace_opened"
  | "research_viewed"
  | "ticker_saved"
  | "pro_feature_used"
  | "upgrade_intent";
export type ResearchFeature =
  | "overview"
  | "chart"
  | "financials"
  | "news"
  | "transcripts"
  | "search"
  | "research";
const sent = new Set<string>();
let anonymousId: string | undefined;
let attribution: Record<string, string> = {};

const ATTRIBUTION_STORAGE_KEY = "gloomberb.web.attribution";
const ANONYMOUS_ID_STORAGE_KEY = "gloomberb.web.anonymous-id";
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "twclid",
] as const;
const FIRST_TOUCH_KEYS = [
  "first_touch_at",
  "first_touch_landing_page",
  "first_touch_referrer",
  ...CAMPAIGN_KEYS.map((key) => `first_touch_${key}` as const),
] as const;

function cleanValue(value: unknown, maxLength = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function isFresh(at: string | undefined, now: number): boolean {
  const age = now - Date.parse(at ?? "");
  return Number.isFinite(age) && age >= 0 && age < ATTRIBUTION_WINDOW_MS;
}

/** A referrer only counts when it is another site; our own pages are not a source. */
function externalReferrer(referrer: string | undefined, href: string): string | undefined {
  const value = cleanValue(referrer, 500);
  if (!value) return undefined;
  try {
    return new URL(value).origin === new URL(href).origin ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Merges what this page load reveals into the stored attribution. The first
 * touch (landing page, external referrer, and any campaign on it) is written
 * once and kept for 30 days so a signup on a later visit still knows how the
 * visitor originally arrived. Campaign fields track the most recent click: a
 * new campaign replaces the old click id instead of inheriting it. Both parts
 * expire independently.
 */
export function resolveBrowserAttribution({
  href,
  now = Date.now(),
  referrer,
  stored,
}: {
  href: string;
  now?: number;
  referrer?: string;
  stored: string | null;
}): Record<string, string> {
  const url = new URL(href);
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stored ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    /* Corrupt storage is the same as no storage. */
  }

  const next: Record<string, string> = {};
  if (isFresh(cleanValue(saved.first_touch_at, 40), now)) {
    for (const key of FIRST_TOUCH_KEYS) {
      const value = cleanValue(saved[key], key.includes("referrer") || key.includes("landing") ? 500 : 300);
      if (value) next[key] = value;
    }
  }
  if (isFresh(cleanValue(saved.last_touch_at, 40), now)) {
    next.last_touch_at = cleanValue(saved.last_touch_at, 40)!;
    for (const key of CAMPAIGN_KEYS) {
      const value = cleanValue(saved[key]);
      if (value) next[key] = value;
    }
  }

  const campaign: Partial<Record<(typeof CAMPAIGN_KEYS)[number], string>> = {};
  for (const key of CAMPAIGN_KEYS) {
    const value = cleanValue(url.searchParams.get(key));
    if (value) campaign[key] = value;
  }
  const capturedAt = new Date(now).toISOString();
  if (Object.keys(campaign).length > 0) {
    for (const key of CAMPAIGN_KEYS) delete next[key];
    next.last_touch_at = capturedAt;
    Object.assign(next, campaign);
  }

  if (!next.first_touch_at) {
    next.first_touch_at = capturedAt;
    next.first_touch_landing_page = url.pathname;
    const source = externalReferrer(referrer, href);
    if (source) next.first_touch_referrer = source;
    for (const key of CAMPAIGN_KEYS) {
      const value = campaign[key];
      if (value) next[`first_touch_${key}`] = value;
    }
  }

  return next;
}

/** Hosted web analytics only. Native local use never creates an identifier. */
export function initializeBrowserResearchActivity(): void {
  try {
    if (
      navigator.doNotTrack === "1" ||
      (navigator as Navigator & { globalPrivacyControl?: boolean })
        .globalPrivacyControl
    )
      return;
    const url = new URL(location.href);
    const incoming = url.searchParams.get("_gloom");
    const stored = localStorage.getItem(ANONYMOUS_ID_STORAGE_KEY);
    anonymousId =
      [incoming, stored].find(
        (value) => value && /^[a-f0-9-]{36}$/.test(value),
      ) ?? crypto.randomUUID();
    localStorage.setItem(ANONYMOUS_ID_STORAGE_KEY, anonymousId);
    attribution = resolveBrowserAttribution({
      href: url.href,
      referrer: document.referrer,
      stored: localStorage.getItem(ATTRIBUTION_STORAGE_KEY),
    });
    localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
    url.searchParams.delete("_gloom");
    history.replaceState(history.state, "", url.href);
  } catch {
    /* Private browsing must still work. */
  }
}

/** What the server stores against the account: stored touches plus the product marker. */
function attributionPayload(): Record<string, string> | undefined {
  if (getCurrentPluginTarget() !== "web") return undefined;
  return { product: "gloomberb", ...attribution };
}

/** Counts milestones once per feature/session/account, never their content. */
export function recordResearchActivity(
  event: ResearchActivity,
  feature?: ResearchFeature,
): void {
  const target = getCurrentPluginTarget();
  const user = apiClient.getCurrentUser();
  if (target === "web" ? !anonymousId : !user) return;
  const key = `${user?.id ?? "guest"}:${event}:${feature ?? ""}`;
  if (sent.has(key)) return;
  sent.add(key);
  if (event !== "workspace_opened") recordResearchActivity("workspace_opened");
  void apiClient
    .recordResearchActivity({
      event,
      eventId: crypto.randomUUID(),
      surface: target === "desktop" ? "desktop" : target,
      anonymousId: target === "web" ? anonymousId : undefined,
      attribution: attributionPayload(),
      feature,
    })
    .catch(() => {
      sent.delete(key);
    });
}

/**
 * Ties the visitor to the account right after sign-up or sign-in. Milestones
 * are keyed by account, so the first one under the new user id carries the
 * stored attribution and the anonymous id to the server; without this call a
 * visitor who signs up and leaves is never attributed.
 */
export function identifyResearchUser(): void {
  try {
    recordResearchActivity("workspace_opened");
  } catch {
    /* Analytics never blocks sign-in. */
  }
}

export function researchUpgradeUrl(returnTo?: string): string {
  const url = new URL("https://gloom.sh/cloud?upgrade=pro");
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  if (anonymousId) url.searchParams.set("_gloom", anonymousId);
  for (const [key, value] of Object.entries(attribution)) {
    if (/^(utm_(source|medium|campaign|content|term)|twclid)$/.test(key))
      url.searchParams.set(key, value);
  }
  return url.href;
}
