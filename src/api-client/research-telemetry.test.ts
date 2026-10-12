import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "./index";
import { getCurrentPluginTarget, setCurrentPluginTarget } from "../plugins/current-target";
import { currentTelemetryConfig, reportTelemetryConfig } from "../telemetry/live-config";
import { installUsageCounter, resetUsageCountsForTests, usageCountsEnabled } from "../telemetry/usage-counts";
import {
  adoptDesktopHandoff,
  exposeUpgradePersonalized,
  exposeWallTeaser,
  exposeWebExperiment,
  initializeBrowserResearchActivity,
  initializeDesktopResearchActivity,
  recordResearchActivity,
  researchUpgradeUrl,
} from "./research-activity";

const envKeys = ["GLOOMBERB_NO_TELEMETRY", "DO_NOT_TRACK"] as const;
const originalEnv = envKeys.map((key) => process.env[key]);
const globalKeys = ["navigator", "localStorage", "sessionStorage", "location", "document", "history"] as const;
const originalGlobals = globalKeys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
const originalTarget = getCurrentPluginTarget();
const originalTelemetry = currentTelemetryConfig(undefined)?.telemetry;
const requests: Array<{ path: string; event: string }> = [];

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function setGlobal(key: typeof globalKeys[number], value: unknown) {
  Object.defineProperty(globalThis, key, { configurable: true, value });
}

function signIn(id: string) {
  apiClient.setSessionToken("research-telemetry-test");
  apiClient.restoreCachedUser({ id, email: "research@example.com", emailVerified: true, plan: "free" });
}

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  reportTelemetryConfig(undefined);
  resetUsageCountsForTests();
  requests.length = 0;
  setGlobal("navigator", {});
  setGlobal("localStorage", memoryStorage());
  setGlobal("sessionStorage", memoryStorage());
  setGlobal("location", { href: "https://term.gloom.sh/?utm_source=test" });
  setGlobal("document", { referrer: "" });
  setGlobal("history", { state: null, replaceState() {} });
  setCloudApiFetchTransport(async (url, init) => {
    requests.push({ path: new URL(url).pathname, event: JSON.parse(String(init?.body)).event });
    return new Response(JSON.stringify({ accepted: true, variant: "control" }));
  });
  initializeDesktopResearchActivity(localStorage);
});

afterEach(() => {
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  setCloudApiFetchTransport(null);
  resetUsageCountsForTests();
  reportTelemetryConfig(originalTelemetry);
  setCurrentPluginTarget(originalTarget);
  envKeys.forEach((key, index) => {
    const value = originalEnv[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  globalKeys.forEach((key, index) => {
    const descriptor = originalGlobals[index];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
});

test("all surfaces apply usage and environment opt-outs before sending or reserving milestones", async () => {
  const optOuts = [
    () => reportTelemetryConfig({ usage: false }),
    () => { process.env.GLOOMBERB_NO_TELEMETRY = "1"; },
    () => { process.env.DO_NOT_TRACK = "1"; },
  ];
  for (const target of ["web", "desktop", "tui", "cli"] as const) {
    setCurrentPluginTarget(target);
    for (const [index, optOut] of optOuts.entries()) {
      signIn(`research-opt-out-${target}-${index}`);
      optOut();
      const before = requests.length;
      recordResearchActivity("research_viewed", "research");
      recordResearchActivity("onboarding_completed");
      expect(await exposeWallTeaser()).toBeNull();
      expect(await exposeUpgradePersonalized("upgrade-sheet")).toBeNull();
      await Bun.sleep(0);
      expect(requests).toHaveLength(before);

      reportTelemetryConfig(undefined);
      for (const key of envKeys) delete process.env[key];
      recordResearchActivity("research_viewed", "research");
      await Bun.sleep(0);
      expect(requests.slice(before)).toEqual([
        { path: "/activity/research", event: "workspace_opened" },
        { path: "/activity/research", event: "research_viewed" },
      ]);
    }
  }
});

test("the desktop host's launch opt-out blocks attribution and signed-in milestones without process env", async () => {
  setCurrentPluginTarget("desktop");
  signIn("research-desktop-launch-opt-out");
  installUsageCounter({ surface: "desktop", isEnabled: () => false, getInstallId: () => null });
  const storage = memoryStorage();
  expect(adoptDesktopHandoff(`gloomberb://cloud/success?_gloom=${crypto.randomUUID()}&utm_source=test`, storage)).toBe(false);
  initializeDesktopResearchActivity(storage);
  recordResearchActivity("research_viewed", "research");
  await Bun.sleep(0);
  expect(storage.values.size).toBe(0);
  expect(requests).toEqual([]);
});

test("saved browser usage opt-out prevents first-load identification and activity", async () => {
  setCurrentPluginTarget("web");
  const config = { telemetry: { usage: false } };
  installUsageCounter({ surface: "web", isEnabled: () => usageCountsEnabled(config), getInstallId: () => null });
  const storage = memoryStorage();
  setGlobal("localStorage", storage);
  initializeBrowserResearchActivity();
  recordResearchActivity("workspace_opened");
  signIn("research-browser-saved-opt-out");
  recordResearchActivity("workspace_opened");
  await Bun.sleep(0);
  expect(storage.values.size).toBe(0);
  expect(requests).toEqual([]);
});

test("browser privacy signals suppress existing anonymous ids and signed-in research activity", async () => {
  setCurrentPluginTarget("web");
  initializeBrowserResearchActivity();
  expect(new URL(researchUpgradeUrl()).searchParams.has("_gloom")).toBe(true);
  for (const privacy of [{ doNotTrack: "1" }, { globalPrivacyControl: true }]) {
    setGlobal("navigator", privacy);
    apiClient.setSessionToken(null);
    apiClient.restoreCachedUser(null);
    recordResearchActivity("research_viewed", "research");
    expect(await exposeWebExperiment("web_terminal_trial_offer")).toBeNull();
    signIn(`research-browser-privacy-${Object.keys(privacy)[0]}`);
    recordResearchActivity("research_viewed", "research");
    const upgrade = new URL(researchUpgradeUrl("gloomberb://cloud/success"));
    expect(upgrade.searchParams.get("returnTo")).toBe("gloomberb://cloud/success");
    expect(upgrade.searchParams.has("_gloom")).toBe(false);
    expect(upgrade.searchParams.has("utm_source")).toBe(false);
  }
  await Bun.sleep(0);
  expect(requests).toEqual([]);
});
