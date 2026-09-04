import { apiClient } from "./index";
import { getCurrentPluginTarget } from "../plugins/current-target";

export type ResearchActivity = "workspace_opened" | "research_viewed" | "ticker_saved" | "pro_feature_used" | "upgrade_intent";
export type ResearchFeature = "overview" | "chart" | "financials" | "news" | "transcripts" | "search" | "research";
const sent = new Set<string>();
let anonymousId: string | undefined;
let attribution: Record<string, string> = {};

/** Hosted web analytics only. Native local use never creates an identifier. */
export function initializeBrowserResearchActivity(): void {
  try {
    if (navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
    const url = new URL(location.href);
    const incoming = url.searchParams.get("_gloom");
    const stored = localStorage.getItem("gloomberb.web.anonymous-id");
    anonymousId = [incoming, stored].find((value) => value && /^[a-f0-9-]{36}$/.test(value)) ?? crypto.randomUUID();
    localStorage.setItem("gloomberb.web.anonymous-id", anonymousId);
    const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "twclid"];
    const saved = JSON.parse(localStorage.getItem("gloomberb.web.attribution") ?? "{}");
    const age = Date.now() - Date.parse(saved?.last_touch_at ?? "");
    attribution = Number.isFinite(age) && age >= 0 && age < 30 * 24 * 60 * 60 * 1000 ? saved : {};
    if (keys.some((key) => url.searchParams.has(key))) {
      // A new campaign replaces the old click id instead of inheriting it.
      attribution = { last_touch_at: new Date().toISOString() };
      for (const key of keys) {
        const value = url.searchParams.get(key);
        if (value) attribution[key] = value.slice(0, 300);
      }
    }
    localStorage.setItem("gloomberb.web.attribution", JSON.stringify(attribution));
    url.searchParams.delete("_gloom");
    history.replaceState(history.state, "", url.href);
  } catch { /* Private browsing must still work. */ }
}

/** Counts milestones once per feature/session/account, never their content. */
export function recordResearchActivity(event: ResearchActivity, feature?: ResearchFeature): void {
  const target = getCurrentPluginTarget();
  const user = apiClient.getCurrentUser();
  if (target === "web" ? !anonymousId : !user) return;
  const key = `${user?.id ?? "guest"}:${event}:${feature ?? ""}`;
  if (sent.has(key)) return;
  sent.add(key);
  if (event !== "workspace_opened") recordResearchActivity("workspace_opened");
  void apiClient.recordResearchActivity({ event, eventId: crypto.randomUUID(),
    surface: target === "desktop" ? "desktop" : target,
    anonymousId: target === "web" ? anonymousId : undefined,
    attribution: target === "web" ? attribution : undefined, feature,
  }).catch(() => { sent.delete(key); });
}

export function researchUpgradeUrl(returnTo?: string): string {
  const url = new URL("https://gloom.sh/cloud?upgrade=pro");
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  if (anonymousId) url.searchParams.set("_gloom", anonymousId);
  for (const [key, value] of Object.entries(attribution)) {
    if (/^(utm_(source|medium|campaign|content|term)|twclid)$/.test(key)) url.searchParams.set(key, value);
  }
  return url.href;
}
