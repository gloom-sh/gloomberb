import { afterEach, describe, expect, test } from "bun:test";
import { CloudTelemetryApi, type AttentionCountsPayload } from "../api-client/telemetry";
import { apiClient } from "../api-client";
import { verifiedUser } from "../test-support/cloud-api";
import { normalizeLoadedConfig, normalizeConfigForSave } from "../data/config/store/normalize";
import { createDefaultConfig } from "../types/config";
import { __syncContributorInternalsForTests } from "../sync/core-contributors";
import { AttentionCounter, attentionCountsEnabled } from "./attention-counts";
import { runAutomated } from "./usage-counts";

const counters: AttentionCounter[] = [];
afterEach(() => { for (const counter of counters.splice(0)) counter.dispose(); });

function harness() {
  const state = { enabled: true, session: {} as object | null, now: 3_600_000 };
  const sent: AttentionCountsPayload[] = [];
  const signals: AbortSignal[] = [];
  let sender = async (payload: AttentionCountsPayload, signal: AbortSignal) => { sent.push(payload); signals.push(signal); };
  const counter = new AttentionCounter({
    isEnabled: () => state.enabled,
    verifiedSession: () => state.session,
    now: () => state.now,
    send: (payload, signal) => sender(payload, signal),
  });
  counters.push(counter);
  return { state, counter, sent, signals, send: (next: typeof sender) => { sender = next; } };
}

describe("attention consent", () => {
  test("credential replacement invalidates counts before the new user is restored", async () => {
    apiClient.setSessionToken("attention-account-one");
    apiClient.restoreCachedUser(verifiedUser);
    const sent: AttentionCountsPayload[] = [];
    const counter = new AttentionCounter({ isEnabled: () => true,
      verifiedSession: () => apiClient.getVerifiedSessionIdentity(),
      send: async (payload) => { sent.push(payload); } });
    counters.push(counter);
    const stop = apiClient.subscribeCurrentUser(() => counter.refresh());
    try {
      const original = apiClient.getVerifiedSessionIdentity();
      const pendingOpen = counter.capture();
      pendingOpen("AAPL", "des");
      // The legacy UI still has its cached user in this window, but that user
      // is not proof of which account owns the newly installed credential.
      apiClient.setSessionToken("attention-account-two");
      expect(apiClient.getCurrentUser()).not.toBeNull();
      expect(apiClient.getVerifiedSessionIdentity()).toBeNull();
      counter.capture()("MSFT", "des");
      apiClient.restoreCachedUser({ ...verifiedUser, id: "attention-other-account" });
      expect(apiClient.getVerifiedSessionIdentity()).not.toBe(original);
      pendingOpen("NVDA", "chart");
      counter.capture()("VOD:LSE", "des");
      await counter.flush();
      expect(sent).toEqual([{ consent: true, events: [{ symbol: "VOD:LSE", action: "des" }] }]);
    } finally {
      stop();
      apiClient.setSessionToken(null);
    }
  });
  test("cloud sync never exports consent or accepts remote opt-in", () => {
    const local = createDefaultConfig("/tmp/attention-sync");
    const enabled = { ...local, telemetry: { attention: true } };
    const pushed = __syncContributorInternalsForTests.collectCoreConfigPayload(enabled);
    expect(JSON.stringify(pushed)).not.toContain("telemetry");
    const pulled = __syncContributorInternalsForTests.mergeConfigPayload(local, { telemetry: { attention: true } });
    expect(attentionCountsEnabled(pulled)).toBe(false);
    const optedOut = { ...local, telemetry: { attention: false } };
    const remote = __syncContributorInternalsForTests.mergeConfigPayload(optedOut, { telemetry: { attention: true } });
    expect(remote?.telemetry?.attention).toBe(false);
  });
  test("old, malformed and usage-enabled settings never become ticker consent", () => {
    for (const telemetry of [undefined, {}, { usage: true }, { usage: false }, { attention: "true" }, { attention: 1 }]) {
      const { config } = normalizeLoadedConfig({ ...createDefaultConfig("/tmp/attention-config"), telemetry }, "/tmp/attention-config");
      expect(attentionCountsEnabled(config)).toBe(false);
    }
    const config = normalizeConfigForSave({ ...createDefaultConfig("/tmp/attention-config"), telemetry: { attention: true, usage: false } });
    expect(attentionCountsEnabled(config)).toBe(true);
    expect(attentionCountsEnabled(config, { DO_NOT_TRACK: "1" })).toBe(false);
    expect(attentionCountsEnabled(config, { GLOOMBERB_NO_TELEMETRY: "1" })).toBe(false);
  });

  test("does not capture signed-out or disabled activity retroactively", async () => {
    const h = harness();
    h.state.enabled = false;
    const beforeOptIn = h.counter.capture();
    h.state.enabled = true;
    beforeOptIn("AAPL", "des");
    h.state.session = null;
    const beforeAuth = h.counter.capture();
    h.state.session = {};
    beforeAuth("MSFT", "des");
    await h.counter.flush();
    expect(h.sent).toEqual([]);
  });

  test("opt-out immediately destroys pending activity and invalidates async opens", async () => {
    const h = harness();
    const resolvedLater = h.counter.capture();
    h.counter.capture()("AAPL", "des");
    h.state.enabled = false;
    h.counter.refresh();
    h.state.enabled = true;
    resolvedLater("MSFT", "chart");
    h.counter.capture()("7203:TSE", "quote");
    await h.counter.flush();
    expect(h.sent).toEqual([{ consent: true, events: [{ symbol: "7203:TSE", action: "quote" }] }]);
  });

  test("an account change while resolving or waiting to flush drops old counts", async () => {
    const h = harness();
    const resolvedLater = h.counter.capture();
    h.counter.capture()("AAPL", "des");
    h.state.session = {};
    resolvedLater("MSFT", "chart");
    await h.counter.flush();
    expect(h.sent).toEqual([]);
    h.counter.capture()("VOD:LSE", "des");
    h.state.session = null;
    await h.counter.flush();
    expect(h.sent).toEqual([]);
  });

  test("opt-out aborts an in-flight request without retrying or reviving its queue", async () => {
    const h = harness();
    const network = Promise.withResolvers<void>();
    h.send(async (payload, signal) => { h.sent.push(payload); h.signals.push(signal); await network.promise; });
    h.counter.capture()("AAPL", "des");
    const pendingFlush = h.counter.flush();
    h.counter.capture()("MSFT", "chart");
    h.state.enabled = false;
    h.counter.refresh();
    expect(h.signals[0]?.aborted).toBe(true);
    h.state.enabled = true;
    network.resolve();
    await pendingFlush;
    await h.counter.flush();
    expect(h.sent).toHaveLength(1);
  });
});

describe("attention batching", () => {
  test("bounds and deduplicates counts, allowlists every field, and rejects invalid ticker text", async () => {
    const h = harness();
    const record = h.counter.capture();
    record("  vod:lse  ", "des");
    record("VOD:LSE", "des");
    record("VOD:LSE", "chart");
    record("my private research query", "des");
    record("AAPL?account=secret", "des");
    for (let index = 0; index < 150; index += 1) record(`T${index}`, "quote");
    await h.counter.flush();
    expect(h.sent[0]?.events).toHaveLength(100);
    expect(h.sent[0]?.events.slice(0, 2)).toEqual([
      { symbol: "VOD:LSE", action: "des" }, { symbol: "VOD:LSE", action: "chart" },
    ]);
    expect(Object.keys(h.sent[0]!)).toEqual(["consent", "events"]);
    for (const event of h.sent[0]!.events) expect(Object.keys(event)).toEqual(["symbol", "action"]);
  });

  test("never counts automation, including an open that resolves after automation ends", async () => {
    const h = harness();
    const complete = await runAutomated(() => h.counter.capture());
    complete("AAPL", "des");
    await h.counter.flush();
    expect(h.sent).toEqual([]);
  });

  test("drops stale and prior-hour counts after a suspended runtime wakes", async () => {
    const h = harness();
    h.counter.capture()("AAPL", "des");
    h.state.now += 120_001;
    await h.counter.flush();
    expect(h.sent).toEqual([]);
    h.state.now = 7_199_999;
    h.counter.capture()("MSFT", "des");
    h.state.now += 1;
    await h.counter.flush();
    expect(h.sent).toEqual([]);
    h.counter.capture()("SAP:XETRA", "des");
    await h.counter.flush();
    expect(h.sent[0]?.events).toEqual([{ symbol: "SAP:XETRA", action: "des" }]);
  });

  test("failed requests are dropped and concurrent flushes cannot duplicate a batch", async () => {
    const h = harness();
    const network = Promise.withResolvers<void>();
    let attempts = 0;
    h.send(async () => { attempts += 1; await network.promise; throw new Error("offline"); });
    h.counter.capture()("AAPL", "des");
    const first = h.counter.flush();
    await h.counter.flush();
    network.resolve();
    await first;
    await h.counter.flush();
    expect(attempts).toBe(1);
  });

  test("disposed surface cannot retain or send pending or unresolved activity", async () => {
    const h = harness();
    const finish = h.counter.capture();
    finish("AAPL", "des");
    h.counter.dispose();
    finish("MSFT", "des");
    await h.counter.flush();
    expect(h.sent).toEqual([]);
  });
});

test("attention transport strips runtime identity fields and forwards cancellation", async () => {
  let sent: RequestInit | undefined;
  const network = Promise.withResolvers<void>();
  const api = new CloudTelemetryApi(async <T>(path: string, init?: RequestInit) => {
    expect(path).toBe("/telemetry/attention");
    sent = init;
    await network.promise;
    return undefined as T;
  });
  const controller = new AbortController();
  const payload = { consent: true as const, installId: "do-not-send", userId: "do-not-send",
    events: [{ symbol: "0700.HK", action: "quote" as const, sessionId: "do-not-send", at: "do-not-send" }] };
  const request = api.reportAttentionCounts(payload, controller.signal);
  expect(JSON.parse(String(sent?.body))).toEqual({ consent: true, events: [{ symbol: "0700.HK", action: "quote" }] });
  expect(sent?.keepalive).toBeUndefined();
  controller.abort();
  expect(sent?.signal?.aborted).toBe(true);
  network.resolve();
  await request;
});
