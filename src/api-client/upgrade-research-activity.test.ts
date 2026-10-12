import { afterEach, expect, test } from "bun:test";
import { apiClient } from "./index";
import { getCurrentPluginTarget, setCurrentPluginTarget } from "../plugins/current-target";
import { exposeUpgradePersonalized } from "./research-activity";

const originalExposure = apiClient.recordExperimentExposure;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalTarget = getCurrentPluginTarget();

function browserGlobals(navigator: object = {}) {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } },
  });
}

function signIn(id: string, plan: "free" | "pro" = "free") {
  apiClient.setSessionToken("upgrade-test-session");
  apiClient.restoreCachedUser({ id, email: "upgrade@example.com", emailVerified: true, plan });
}

afterEach(() => {
  apiClient.recordExperimentExposure = originalExposure;
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  setCurrentPluginTarget(originalTarget);
  for (const [key, descriptor] of [["navigator", originalNavigator], ["sessionStorage", originalSession]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("the exposure names the experiment and where it showed, never the holdings", async () => {
  browserGlobals();
  setCurrentPluginTarget("desktop");
  signIn("upgrade-exposure-account");
  const calls: Array<Parameters<typeof apiClient.recordExperimentExposure>[0]> = [];
  apiClient.recordExperimentExposure = async (payload) => {
    calls.push(payload);
    return { accepted: true, variant: "personalized" };
  };
  expect(await exposeUpgradePersonalized("upgrade-sheet")).toBe("personalized");
  expect(calls).toHaveLength(1);
  const { eventId, ...rest } = calls[0]!;
  expect(eventId).toMatch(/^[a-f0-9-]{36}$/);
  expect(rest).toEqual({ surface: "desktop", experiment: "upgrade_personalized", placement: "upgrade-sheet" });
  // Asked once per account and session.
  expect(await exposeUpgradePersonalized("onboarding-pro")).toBe("personalized");
  expect(calls).toHaveLength(1);
});

test("signed-out, Pro and opted-out viewers are never asked and keep the generic copy", async () => {
  let asked = 0;
  apiClient.recordExperimentExposure = async () => {
    asked += 1;
    return { accepted: true, variant: "personalized" };
  };
  setCurrentPluginTarget("desktop");
  browserGlobals();
  expect(await exposeUpgradePersonalized("upgrade-sheet")).toBeNull();
  signIn("upgrade-pro-account", "pro");
  expect(await exposeUpgradePersonalized("upgrade-sheet")).toBeNull();
  for (const navigator of [{ doNotTrack: "1" }, { globalPrivacyControl: true }, { webdriver: true }]) {
    browserGlobals(navigator);
    signIn(`upgrade-opted-out-${Object.keys(navigator)[0]}`);
    expect(await exposeUpgradePersonalized("upgrade-sheet")).toBeNull();
  }
  expect(asked).toBe(0);
});
