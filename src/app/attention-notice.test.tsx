import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../api-client";
import type { AttentionCountsPayload } from "../api-client/telemetry";
import { setConfigStoreHost, type ConfigStoreHost } from "../data/config/store";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { openTuiToastHost } from "../renderers/opentui/toast-host";
import { setAppActive } from "../state/app/activity";
import { AppProvider, useAppDispatch, useAppGetState, type AppState } from "../state/app/context";
import { flushPendingPersistence } from "../state/persist-scheduler";
import {
  __flushAttentionCountsForTests,
  captureAttentionAction,
  installAttentionCounter,
} from "../telemetry/attention-counts";
import { reportTelemetryConfig } from "../telemetry/live-config";
import { verifiedUser } from "../test-support/cloud-api";
import { createDefaultConfig, type AppConfig, type TelemetryConfig } from "../types/config";
import type { AppNotificationRequest } from "../types/plugin";
import { AttentionCountsNotice, type AccountSettingsSource } from "./attention-notice";

const tui = createOpenTuiTestHarness({ width: 100, height: 12 });
const NOTICE = "Attention Counts is now on";
const originalSend = apiClient.reportAttentionCounts;
let sent: AttentionCountsPayload[] = [];
let saved: AppConfig[] = [];
let stopCounter: (() => void) | null = null;
let dispatchConfig: (config: AppConfig) => void = () => {};

/** The account's synced settings: pulled this session or not yet. */
function accountSettings(pulled: boolean): AccountSettingsSource & { pull(): void } {
  const listeners = new Set<() => void>();
  let status = { lastPullAt: pulled ? "2026-10-31T12:29:00Z" : null as string | null };
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getStatus: () => status,
    pull: () => {
      status = { lastPullAt: "2026-10-31T12:30:00Z" };
      for (const listener of listeners) listener();
    },
  };
}

/** What the app's notifier does with a request: a toast, persistent ones until dismissed. */
function notify(request: AppNotificationRequest): void {
  openTuiToastHost.info(request.body, {
    title: request.title,
    duration: request.persistent ? 0 : request.duration,
    action: request.action,
    onShown: request.onShown,
  });
}

function signIn(emailVerified = true): void {
  apiClient.setSessionToken(`attention-notice-${emailVerified ? "verified" : "unverified"}`);
  apiClient.restoreCachedUser({ ...verifiedUser, emailVerified });
}

/**
 * One launch: the counter as an entry point installs it (unless `collector`
 * is false, as in the CLI), then the notice with a toast viewport.
 */
async function launch(telemetry?: TelemetryConfig, {
  allowed = true,
  collector = true,
  settings = accountSettings(true),
}: { allowed?: boolean; collector?: boolean; settings?: AccountSettingsSource } = {}): Promise<() => AppState> {
  const config: AppConfig = { ...createDefaultConfig("/tmp/gloomberb-attention-notice"), ...(telemetry ? { telemetry } : {}) };
  reportTelemetryConfig(config.telemetry);
  if (collector) {
    stopCounter = installAttentionCounter({
      allowed: () => allowed,
      launchConfig: () => config,
      accountSettingsPulled: () => settings.getStatus().lastPullAt !== null,
    });
  }
  let getState: (() => AppState) | null = null;
  function Probe() {
    getState = useAppGetState();
    const dispatch = useAppDispatch();
    dispatchConfig = (next) => dispatch({ type: "SET_CONFIG", config: next });
    return null;
  }
  await tui.render(
    <AppProvider config={config}>
      <AttentionCountsNotice notify={notify} accountSettings={settings} />
      <openTuiToastHost.Viewport />
      <Probe />
    </AppProvider>,
  );
  await tui.renderFrames(3);
  return () => getState!();
}

/** Opens a ticker the way a DES open is counted, then sends at once. */
async function open(symbol: string): Promise<void> {
  captureAttentionAction()(symbol, "des");
  await __flushAttentionCountsForTests();
}

describe("Attention Counts notice", () => {
  beforeEach(() => {
    // Mid-hour, so a count is never dropped for crossing into the next hour.
    setSystemTime(new Date("2026-10-31T12:30:00Z"));
    sent = [];
    saved = [];
    apiClient.reportAttentionCounts = async (payload) => { sent.push(payload); };
    setConfigStoreHost({ saveConfig: async (config: AppConfig) => { saved.push(config); } } as unknown as ConfigStoreHost);
  });

  afterEach(async () => {
    stopCounter?.();
    stopCounter = null;
    await act(async () => {
      while (openTuiToastHost.dismissNewest?.()) { /* the toast store outlives the test */ }
      setAppActive(true);
      apiClient.setSessionToken(null);
    });
    await flushPendingPersistence();
    setConfigStoreHost(null);
    apiClient.reportAttentionCounts = originalSend;
    reportTelemetryConfig(undefined);
    setSystemTime();
  });

  test("a fresh install counts nothing until the notice is drawn, then counts", async () => {
    signIn();
    await act(async () => setAppActive(false));
    const state = await launch();
    // In the background the notice waits, and so does counting.
    expect(tui.frame()).not.toContain(NOTICE);
    await open("AAPL");
    expect(sent).toEqual([]);

    await act(async () => setAppActive(true));
    await tui.waitForFrameToContain(NOTICE);
    expect(state().config.telemetry).toEqual({ attentionNoticeShownTo: [verifiedUser.id] });
    await open("MSFT");
    expect(sent).toEqual([{ consent: true, events: [{ symbol: "MSFT", action: "des" }] }]);
    await flushPendingPersistence();
    expect(saved.at(-1)?.telemetry).toEqual({ attentionNoticeShownTo: [verifiedUser.id] });
  });

  test("Turn off switches it off and nothing is counted after", async () => {
    signIn();
    const state = await launch();
    await tui.waitForFrameToContain(NOTICE);
    await tui.clickFrameText("Turn off");
    expect(state().config.telemetry?.attention).toBe(false);
    await tui.waitForFrameToContain("Totals already published");
    await open("NVDA");
    expect(sent).toEqual([]);
  });

  test("an explicit off stays off and never sees the notice", async () => {
    signIn();
    const state = await launch({ attention: false });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
    await open("AAPL");
    expect(sent).toEqual([]);
    expect(state().config.telemetry).toEqual({ attention: false });
  });

  test("an earlier explicit on keeps counting without the notice", async () => {
    signIn();
    await launch({ attention: true });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
    await open("AAPL");
    expect(sent).toEqual([{ consent: true, events: [{ symbol: "AAPL", action: "des" }] }]);
  });

  test("signed out or unverified: no notice and nothing counted", async () => {
    await launch();
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
    await open("AAPL");

    await act(async () => signIn(false));
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
    await open("MSFT");
    expect(sent).toEqual([]);
  });

  test("waits for the account's synced settings, so an off from another device comes first", async () => {
    signIn();
    const settings = accountSettings(false);
    const state = await launch(undefined, { settings });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
    await open("AAPL");
    expect(sent).toEqual([]);

    // The pull brought the account's off: no notice, nothing counted.
    await act(async () => {
      const config = state().config;
      const telemetry = { ...config.telemetry, attention: false };
      reportTelemetryConfig(telemetry);
      dispatchConfig({ ...config, telemetry });
      settings.pull();
    });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
    await open("MSFT");
    expect(sent).toEqual([]);
  });

  test("a device that already showed the notice counts again only once the account's settings are pulled", async () => {
    signIn();
    const settings = accountSettings(false);
    await launch({ attentionNoticeShownTo: [verifiedUser.id] }, { settings });
    await open("AAPL");
    expect(sent).toEqual([]);
    await act(async () => settings.pull());
    await open("MSFT");
    expect(sent).toEqual([{ consent: true, events: [{ symbol: "MSFT", action: "des" }] }]);
  });

  test("a privacy signal or a surface without a collector shows no notice and counts nothing", async () => {
    signIn();
    // DO_NOT_TRACK, browser Do Not Track or Global Privacy Control.
    const state = await launch(undefined, { allowed: false });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
    await open("AAPL");
    expect(sent).toEqual([]);
    expect(state().config.telemetry).toBeUndefined();
    stopCounter?.();
    stopCounter = null;

    // CLI commands, `shot` and tests install no collector.
    await launch(undefined, { collector: false });
    await tui.renderFrames(5);
    expect(tui.frame()).not.toContain(NOTICE);
  });

  test("another account on the same installation gets its own notice first", async () => {
    signIn();
    const state = await launch({ attentionNoticeShownTo: ["someone-else"] });
    await tui.waitForFrameToContain(NOTICE);
    expect(state().config.telemetry?.attentionNoticeShownTo).toEqual(["someone-else", verifiedUser.id]);
  });
});
