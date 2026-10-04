import { afterEach, describe, expect, test } from "bun:test";
import { apiClient } from "./index";
import { getCurrentPluginTarget, setCurrentPluginTarget } from "../plugins/current-target";
import { adoptDesktopHandoff, exposeWallTeaser, initializeDesktopResearchActivity, recordWallViewed } from "./research-activity";

const originalRecord = apiClient.recordResearchActivity;
const originalExposure = apiClient.recordExperimentExposure;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalTarget = getCurrentPluginTarget();

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function browserGlobals(navigator: object = {}) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
}

function signIn(id: string) {
  apiClient.setSessionToken("wall-test-session");
  apiClient.restoreCachedUser({ id, email: "wall@example.com", emailVerified: true, plan: "free" });
}

afterEach(() => {
  apiClient.recordResearchActivity = originalRecord;
  apiClient.recordExperimentExposure = originalExposure;
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  setCurrentPluginTarget(originalTarget);
  for (const [key, descriptor] of [["navigator", originalNavigator], ["sessionStorage", originalSession], ["localStorage", originalLocal]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("wall milestone boundary", () => {
  test("counts baseline and teaser views once per placement per account, with ids and kind only", async () => {
    browserGlobals();
    setCurrentPluginTarget("desktop");
    signIn("wall-view-first-account");
    const calls: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
    apiClient.recordResearchActivity = async (payload) => { calls.push(payload); };
    recordWallViewed("srch-wall");
    recordWallViewed("srch-wall", "sample");
    recordWallViewed("jobs-wall", "summary");
    recordWallViewed("most-wall", "sample");
    recordWallViewed("flow-wall", "none");
    recordWallViewed("AAPL query text");
    await Promise.resolve();
    signIn("wall-view-second-account");
    recordWallViewed("srch-wall");
    expect(calls.filter((call) => call.event === "wall_viewed").map(({ placement, teaser_kind }) => ({ placement, teaser_kind }))).toEqual([
      { placement: "srch-wall", teaser_kind: undefined },
      { placement: "jobs-wall", teaser_kind: "summary" },
      { placement: "most-wall", teaser_kind: "sample" },
      { placement: "flow-wall", teaser_kind: "none" },
      { placement: "srch-wall", teaser_kind: undefined },
    ]);
    expect(calls.filter((call) => call.event === "wall_viewed").every((call) => !call.feature && !call.tab && !call.desks)).toBe(true);
  });

  test("DNT, GPC and browser automation suppress both exposure and wall milestones for signed-in accounts", async () => {
    let exposures = 0;
    let views = 0;
    apiClient.recordExperimentExposure = async () => { exposures++; return { accepted: true, variant: "teaser" }; };
    apiClient.recordResearchActivity = async () => { views++; };
    setCurrentPluginTarget("web");
    for (const privacy of [{ doNotTrack: "1" }, { globalPrivacyControl: true }, { webdriver: true }]) {
      browserGlobals(privacy);
      signIn(`privacy-${JSON.stringify(privacy)}`);
      expect(await exposeWallTeaser()).toBeNull();
      recordWallViewed("risk-wall", "summary");
    }
    expect(exposures).toBe(0);
    expect(views).toBe(0);
  });

  test("a desktop handoff id cannot enroll signed-out native use, but a Free account can enroll on TUI", async () => {
    browserGlobals();
    adoptDesktopHandoff(`gloomberb://cloud/success?_gloom=${crypto.randomUUID()}`);
    const asks: Array<Parameters<typeof apiClient.recordExperimentExposure>[0]> = [];
    apiClient.recordExperimentExposure = async (payload) => { asks.push(payload); return { accepted: true, variant: "control" }; };
    for (const target of ["desktop", "tui"] as const) {
      setCurrentPluginTarget(target);
      expect(await exposeWallTeaser()).toBeNull();
    }
    signIn("tui-wall-account");
    expect(await exposeWallTeaser()).toBe("control");
    expect(await exposeWallTeaser()).toBe("control");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ experiment: "wall_teaser", surface: "tui", anonymousId: undefined });
    const milestones: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
    apiClient.recordResearchActivity = async (payload) => { milestones.push(payload); };
    recordWallViewed("exec-wall");
    expect(milestones.find((event) => event.event === "wall_viewed")?.attribution?.experiments).toBe("wall_teaser:control");
  });

  test("an exposure rejected by an older platform leaves a baseline wall view without an experiment arm", async () => {
    browserGlobals();
    setCurrentPluginTarget("tui");
    signIn("old-platform-wall-account");
    apiClient.recordExperimentExposure = async () => { throw new Error("422"); };
    const calls: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
    apiClient.recordResearchActivity = async (payload) => { calls.push(payload); };
    expect(await exposeWallTeaser()).toBeNull();
    recordWallViewed("risk-wall");
    expect(calls.find((event) => event.event === "wall_viewed")).toMatchObject({ placement: "risk-wall", attribution: undefined });
  });

  test("an unavailable experiment strips a stale browser wall arm without changing the live trial experiment", async () => {
    browserGlobals();
    setCurrentPluginTarget("web");
    signIn("stale-browser-wall-account");
    adoptDesktopHandoff(`gloomberb://cloud/success?_gloom=${crypto.randomUUID()}`);
    localStorage.setItem("gloomberb.web.experiments", "web_terminal_trial_offer:offer,wall_teaser:teaser");
    apiClient.recordExperimentExposure = async () => { throw new Error("422"); };
    const calls: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
    apiClient.recordResearchActivity = async (payload) => { calls.push(payload); };
    expect(await exposeWallTeaser()).toBeNull();
    recordWallViewed("calls-wall");
    expect(calls.find((event) => event.event === "wall_viewed")?.attribution?.experiments).toBe("web_terminal_trial_offer:offer");
  });

  test("signed-out native walls contribute a placement baseline without creating an identity or workspace event", async () => {
    browserGlobals();
    initializeDesktopResearchActivity(memoryStorage());
    const calls: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
    apiClient.recordResearchActivity = async (payload) => { calls.push(payload); };
    apiClient.recordExperimentExposure = async () => { throw new Error("No-id native visitors must not enroll"); };
    for (const surface of ["desktop", "tui"] as const) {
      setCurrentPluginTarget(surface);
      expect(await exposeWallTeaser()).toBeNull();
      recordWallViewed(`${surface}-wall`);
      recordWallViewed(`${surface}-wall`);
    }
    setCurrentPluginTarget("cli");
    recordWallViewed("cli-wall");
    setCurrentPluginTarget("web");
    recordWallViewed("web-wall");
    await Promise.resolve();
    expect(calls.map(({ event, surface, placement, anonymousId, attribution, teaser_kind }) => ({ event, surface, placement, anonymousId, attribution, teaser_kind }))).toEqual([
      { event: "wall_viewed", surface: "desktop", placement: "desktop-wall", anonymousId: undefined, attribution: undefined, teaser_kind: undefined },
      { event: "wall_viewed", surface: "tui", placement: "tui-wall", anonymousId: undefined, attribution: undefined, teaser_kind: undefined },
    ]);
    expect(calls.every((call) => /^[a-f0-9-]{36}$/.test(call.eventId))).toBe(true);
    expect(sessionStorage.getItem("gloomberb.wall-teaser.views")).toBeNull();
    expect(localStorage.getItem("gloomberb.web.anonymous-id")).toBeNull();
  });

});
