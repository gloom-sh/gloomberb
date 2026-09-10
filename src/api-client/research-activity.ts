import { apiClient } from "./index";
import { getCurrentPluginTarget } from "../plugins/current-target";
import type { DesktopDeepLinkBridge } from "../types/desktop-deeplink";

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
const HANDOFF_ID_KEY = "_gloom";
const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Another device's clock may run slightly ahead; a touch from a minute in the future is still fresh. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ANONYMOUS_ID = /^[a-f0-9-]{36}$/;
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

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function cleanValue(value: unknown, maxLength = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function maxLengthFor(key: string): number {
  return key.includes("referrer") || key.includes("landing") ? 500 : key.endsWith("_at") ? 40 : 300;
}

function isFresh(at: string | undefined, now: number): boolean {
  const age = now - Date.parse(at ?? "");
  return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age < ATTRIBUTION_WINDOW_MS;
}

function cleanUrlValue(value: unknown): string | undefined {
  const cleaned = cleanValue(value, 500);
  if (!cleaned) return undefined;
  try {
    new URL(cleaned);
    return cleaned;
  } catch {
    return undefined;
  }
}

/** A referrer only counts when it is another site; our own pages are not a source. */
function externalReferrer(referrer: string | undefined, href: string): string | undefined {
  const value = cleanUrlValue(referrer);
  if (!value) return undefined;
  return new URL(value).origin === new URL(href).origin ? undefined : value;
}

/** `gloomberb://cloud/success` has no meaningful pathname on its own; keep the host. */
function landingPageOf(url: URL): string {
  return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : `${url.host}${url.pathname}`;
}

/** The stored touches that are still inside their windows; nothing is invented here. */
export function readStoredAttribution(stored: string | null, now = Date.now()): Record<string, string> {
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
      const value = cleanValue(saved[key], maxLengthFor(key));
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
  return next;
}

/**
 * The website forwards the first touch it recorded when it sends a visitor to
 * term.gloom.sh or into the desktop app, so the earliest touch survives the
 * hop. It is only trusted when it is well formed and still inside the window.
 */
function incomingFirstTouch(url: URL, now: number): Record<string, string> | null {
  const at = cleanValue(url.searchParams.get("first_touch_at"), 40);
  if (!at || !isFresh(at, now)) return null;
  const touch: Record<string, string> = { first_touch_at: at };
  for (const key of FIRST_TOUCH_KEYS) {
    if (key === "first_touch_at") continue;
    const raw = url.searchParams.get(key);
    const value = key === "first_touch_referrer" ? cleanUrlValue(raw) : cleanValue(raw, maxLengthFor(key));
    if (value) touch[key] = value;
  }
  return touch;
}

/** Whether a URL carries anything the website hands over: an id, a campaign, or a first touch. */
export function carriesHandoff(href: string): boolean {
  try {
    const params = new URL(href).searchParams;
    return (
      params.has(HANDOFF_ID_KEY) ||
      CAMPAIGN_KEYS.some((key) => params.has(key)) ||
      FIRST_TOUCH_KEYS.some((key) => params.has(key))
    );
  } catch {
    return false;
  }
}

/**
 * Merges what this page load reveals into the stored attribution. The first
 * touch (landing page, external referrer, and any campaign on it) is written
 * once and kept for 30 days so a signup on a later visit still knows how the
 * visitor originally arrived; a first touch forwarded by the website wins over
 * inventing one here. Campaign fields track the most recent click: a new
 * campaign replaces the old click id instead of inheriting it. Both parts
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
  const next = readStoredAttribution(stored, now);

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
    const forwarded = incomingFirstTouch(url, now);
    if (forwarded) Object.assign(next, forwarded);
  }
  if (!next.first_touch_at) {
    next.first_touch_at = capturedAt;
    next.first_touch_landing_page = landingPageOf(url);
    const source = externalReferrer(referrer, href);
    if (source) next.first_touch_referrer = source;
    for (const key of CAMPAIGN_KEYS) {
      const value = campaign[key];
      if (value) next[`first_touch_${key}`] = value;
    }
  }

  return next;
}

function readHandoffId(url: URL): string | undefined {
  const value = url.searchParams.get(HANDOFF_ID_KEY);
  return value && ANONYMOUS_ID.test(value) ? value : undefined;
}

function stripHandoffParams(url: URL): void {
  url.searchParams.delete(HANDOFF_ID_KEY);
  for (const key of FIRST_TOUCH_KEYS) url.searchParams.delete(key);
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
    const incoming = readHandoffId(url);
    const stored = localStorage.getItem(ANONYMOUS_ID_STORAGE_KEY);
    anonymousId =
      [incoming, stored].find(
        (value) => value && ANONYMOUS_ID.test(value),
      ) ?? crypto.randomUUID();
    localStorage.setItem(ANONYMOUS_ID_STORAGE_KEY, anonymousId);
    attribution = resolveBrowserAttribution({
      href: url.href,
      referrer: document.referrer,
      stored: localStorage.getItem(ATTRIBUTION_STORAGE_KEY),
    });
    localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
    stripHandoffParams(url);
    history.replaceState(history.state, "", url.href);
  } catch {
    /* Private browsing must still work. */
  }
}

/**
 * The desktop app never mints an identifier or invents a touch of its own. It
 * only continues what the website handed over in a gloomberb:// link, so a
 * visitor who read gloom.sh, installed the app, and signed up inside it is one
 * person in analytics instead of two.
 */
export function initializeDesktopResearchActivity(storage: StorageLike = localStorage): void {
  try {
    const stored = storage.getItem(ANONYMOUS_ID_STORAGE_KEY);
    anonymousId = stored && ANONYMOUS_ID.test(stored) ? stored : undefined;
    attribution = readStoredAttribution(storage.getItem(ATTRIBUTION_STORAGE_KEY));
  } catch {
    /* A read-only profile still runs the app. */
  }
}

export function adoptDesktopHandoff(href: string, storage: StorageLike = localStorage, now = Date.now()): boolean {
  if (!carriesHandoff(href)) return false;
  try {
    const url = new URL(href);
    const incoming = readHandoffId(url);
    if (incoming) {
      anonymousId = incoming;
      storage.setItem(ANONYMOUS_ID_STORAGE_KEY, incoming);
    }
    attribution = resolveBrowserAttribution({
      href,
      now,
      stored: storage.getItem(ATTRIBUTION_STORAGE_KEY),
    });
    storage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
    return true;
  } catch {
    return false;
  }
}

/**
 * Wraps the deep-link bridge so every link the app receives is inspected for a
 * website handoff before the app acts on it. Wrapping, rather than subscribing
 * separately, matters: the bridge flushes links queued during startup to the
 * first subscriber only, and that subscriber must stay the app.
 */
export function observeDesktopDeepLinks(
  bridge: DesktopDeepLinkBridge,
  storage: StorageLike = localStorage,
): DesktopDeepLinkBridge {
  return {
    subscribe(listener) {
      return bridge.subscribe((deeplink) => {
        adoptDesktopHandoff(deeplink.url, storage);
        listener(deeplink);
      });
    },
  };
}

/** What the server stores against the account: stored touches plus the product marker. */
function attributionPayload(): Record<string, string> | undefined {
  const target = getCurrentPluginTarget();
  if (target === "web") return { product: "gloomberb", ...attribution };
  if (target === "desktop" && Object.keys(attribution).length > 0) return { product: "gloomberb", ...attribution };
  return undefined;
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
      anonymousId: target === "web" || target === "desktop" ? anonymousId : undefined,
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
  if (anonymousId) url.searchParams.set(HANDOFF_ID_KEY, anonymousId);
  for (const [key, value] of Object.entries(attribution)) {
    if (/^(utm_(source|medium|campaign|content|term)|twclid)$/.test(key))
      url.searchParams.set(key, value);
  }
  return url.href;
}
