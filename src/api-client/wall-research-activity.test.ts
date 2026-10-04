import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "./index";
import { getCurrentPluginTarget, setCurrentPluginTarget } from "../plugins/current-target";
import { adoptDesktopHandoff, exposeWallTeaser, initializeDesktopResearchActivity, recordResearchActivity, recordWallCtaClicked, recordWallViewed } from "./research-activity";

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
      expect(await exposeWallTeaser("wall_teaser_signin")).toBeNull();
      recordWallViewed("risk-wall", "summary");
      recordWallCtaClicked("risk-signin", "signup");
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

  test("signed-out native walls send nothing and mint no identifier, even with a desktop handoff", async () => {
    const calls: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
    const exposures: Array<Parameters<typeof apiClient.recordExperimentExposure>[0]> = [];
    apiClient.recordResearchActivity = async (payload) => { calls.push(payload); };
    apiClient.recordExperimentExposure = async (payload) => { exposures.push(payload); return { accepted: false }; };
    const generatedIds = spyOn(crypto, "randomUUID");
    try {
      for (const handedOverId of [undefined, "0f1e2d3c-4b5a-4968-8776-655443322110"]) {
        browserGlobals();
        initializeDesktopResearchActivity(localStorage);
        if (handedOverId) adoptDesktopHandoff(`gloomberb://cloud/success?_gloom=${handedOverId}`);
        for (const surface of ["desktop", "tui", "cli"] as const) {
          setCurrentPluginTarget(surface);
          expect(await exposeWallTeaser()).toBeNull();
          expect(await exposeWallTeaser("wall_teaser_signin")).toBeNull();
          recordWallCtaClicked("risk-signin", "login");
          recordWallCtaClicked("risk-signin", "signup");
          recordWallViewed("risk-signin");
          recordWallViewed("risk-wall");
          recordWallViewed("risk-wall", "summary");
          recordWallViewed("most-wall", "sample");
        }
        await Promise.resolve();
        expect(calls).toHaveLength(0);
        expect(exposures).toHaveLength(0);
        expect(generatedIds).not.toHaveBeenCalled();
        expect(sessionStorage.getItem("gloomberb.wall-teaser.views")).toBeNull();
        expect(localStorage.getItem("gloomberb.web.anonymous-id")).toBe(handedOverId ?? null);
      }
    } finally {
      generatedIds.mockRestore();
    }
  });

  test("excluding native wall views preserves desktop handoff milestones and identified web wall views", async () => {
    browserGlobals();
    initializeDesktopResearchActivity(localStorage);
    const handedOverId = "0f1e2d3c-4b5a-4968-8776-655443322119";
    adoptDesktopHandoff(`gloomberb://cloud/success?_gloom=${handedOverId}`);
    const calls: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
    apiClient.recordResearchActivity = async (payload) => { calls.push(payload); };
    setCurrentPluginTarget("desktop");
    recordWallViewed("risk-wall");
    recordResearchActivity("onboarding_started");
    setCurrentPluginTarget("web");
    recordWallViewed("risk-wall");
    expect(calls.map(({ event, surface, anonymousId }) => ({ event, surface, anonymousId }))).toEqual([
      { event: "workspace_opened", surface: "desktop", anonymousId: handedOverId },
      { event: "onboarding_started", surface: "desktop", anonymousId: handedOverId },
      { event: "wall_viewed", surface: "web", anonymousId: handedOverId },
    ]);
  });

});

test("identified web sign-in walls count each CTA once and keep accepted visitor attribution through signup", async () => {
  browserGlobals();
  setCurrentPluginTarget("web");
  adoptDesktopHandoff(`gloomberb://cloud/success?_gloom=${crypto.randomUUID()}`);
  const asks: Array<Parameters<typeof apiClient.recordExperimentExposure>[0]> = [];
  const events: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
  apiClient.recordExperimentExposure = async (payload) => { asks.push(payload); return { accepted: true, variant: "teaser" }; };
  apiClient.recordResearchActivity = async (payload) => { events.push(payload); };
  expect(await exposeWallTeaser("wall_teaser_signin")).toBe("teaser");
  expect(await exposeWallTeaser("wall_teaser_signin")).toBe("teaser");
  recordWallViewed("risk-signin", "summary");
  recordWallViewed("risk-signin", "summary");
  for (let i = 0; i < 2; i++) {
    recordWallCtaClicked("risk-signin", "login");
    recordWallCtaClicked("risk-signin", "signup");
    recordWallCtaClicked("most-signin", "signup");
    recordWallCtaClicked("AAPL personal query", "signup");
  }
  recordResearchActivity("wall_cta_clicked", undefined, undefined, { placement: "no-cta-signin" });
  await Promise.resolve();
  const clicks = events.filter(({ event }) => event === "wall_cta_clicked");
  expect(clicks.map(({ placement, cta }) => ({ placement, cta }))).toEqual([
    { placement: "risk-signin", cta: "login" },
    { placement: "risk-signin", cta: "signup" },
    { placement: "most-signin", cta: "signup" },
  ]);
  expect(clicks.every((event) => !event.feature && !event.tab && !event.desks && !event.teaser_kind)).toBe(true);
  expect(events.filter(({ event }) => event === "wall_viewed")).toHaveLength(1);
  expect(clicks[0]?.attribution?.experiments).toBe("wall_teaser_signin:teaser");
  expect(JSON.parse(sessionStorage.getItem("gloomberb.wall-teaser.views") ?? "[]")).toHaveLength(4);
  signIn("new-signup-account");
  expect(await exposeWallTeaser("wall_teaser_signin")).toBeNull();
  recordResearchActivity("onboarding_signed_in");
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ experiment: "wall_teaser_signin", surface: "web" });
  expect(events.find(({ event }) => event === "onboarding_signed_in")?.attribution?.experiments).toBe("wall_teaser_signin:teaser");
});

test("unverified accounts get baseline wall counts on every surface without entering the visitor experiment", async () => {
  browserGlobals();
  initializeDesktopResearchActivity(localStorage);
  const events: Array<Parameters<typeof apiClient.recordResearchActivity>[0]> = [];
  let asks = 0;
  apiClient.recordExperimentExposure = async () => { asks++; return { accepted: true, variant: "teaser" }; };
  apiClient.recordResearchActivity = async (payload) => { events.push(payload); };
  for (const surface of ["web", "desktop", "tui", "cli"] as const) {
    setCurrentPluginTarget(surface);
    apiClient.setSessionToken("unverified-session");
    apiClient.restoreCachedUser({ id: `unverified-${surface}`, email: "unverified@example.com", emailVerified: false, plan: "free" });
    expect(await exposeWallTeaser("wall_teaser_signin")).toBeNull();
    recordWallViewed("risk-signin");
    recordWallViewed("risk-signin");
    recordWallCtaClicked("risk-signin", "login");
    recordWallCtaClicked("risk-signin", "login");
  }
  expect(asks).toBe(0);
  expect(events.filter(({ event }) => event === "wall_viewed")).toHaveLength(4);
  expect(events.filter(({ event }) => event === "wall_cta_clicked")).toHaveLength(4);
  expect(events.every((event) => !event.attribution?.experiments)).toBe(true);
});
