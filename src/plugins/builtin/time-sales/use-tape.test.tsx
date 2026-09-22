import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import type { TapeFeedEvent, TapeSnapshot } from "../../../api-client/tape";
import { tapeFixture } from "./test-fixture";
import { TapeClientContext, useTape } from "./use-tape";
import { createSnapshotTapeClient } from "./snapshot-client";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => { if (setup) await act(async () => setup!.renderer.destroy()); setup = undefined; });

// Keep promises under test control to reproduce a bootstrap overtaken by a socket or auth event.
function clientHarness() {
  const requests: Array<{ signal?: AbortSignal; resolve: (data: TapeSnapshot) => void; reject: (error: Error) => void }> = [];
  const listeners = new Set<(event: TapeFeedEvent) => void>();
  return { requests, listeners, client: {
    getCloudTape: (_symbol: string, _exchange: string, signal?: AbortSignal) => new Promise<TapeSnapshot>((resolve, reject) => requests.push({ signal, resolve, reject })),
    subscribeTape: (_symbol: string, _exchange: string, listener: (event: TapeFeedEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, emit: (event: TapeFeedEvent) => { for (const listener of listeners) listener(event); } };
}
async function settle(action?: () => void) { await act(async () => { action?.(); await setup!.renderOnce(); }); }

test("the screenshot context supplies one dated snapshot without a live bootstrap", async () => {
  const initial = tapeFixture();
  let bootstrapCalls = 0;
  const client = createSnapshotTapeClient([["AAPL", "NASDAQ", initial]], async () => {
    bootstrapCalls++;
    throw new Error("Captured tape must not refetch");
  });
  let latest: ReturnType<typeof useTape>;
  function Probe() {
    latest = useTape("AAPL", "NASDAQ", "screenshot", 0);
    return <Text>{latest.data?.generatedAt ?? "empty"}</Text>;
  }
  setup = await testRender(<TapeClientContext.Provider value={client}><Probe /></TapeClientContext.Provider>, { width: 50, height: 3 });
  await settle();
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  expect(latest!.data?.trades).toEqual(initial.trades);
  expect(latest!.snapshotOnly).toBe(true);
  expect(latest!.loading).toBe(false);
  expect(bootstrapCalls).toBe(0);
});

test("live tape wins an older bootstrap, auth reset rejects its pending response, and unmount releases resources", async () => {
  const harness = clientHarness();
  let latest: ReturnType<typeof useTape>;
  let changeSession: (value: number) => void = () => {};
  function Probe() {
    const [session, setSession] = useState(0);
    changeSession = setSession;
    latest = useTape("AAPL", "NASDAQ", session, 0, harness.client);
    return <Text>{latest.data?.generatedAt ?? "empty"}</Text>;
  }
  setup = await testRender(<Probe />, { width: 50, height: 3 });
  await settle();
  const initial = tapeFixture();
  const newer = { ...initial, generatedAt: "2026-09-22T16:00:01.000Z" };
  await settle(() => harness.emit({ type: "data", payload: newer }));
  await settle(() => harness.requests[0]!.resolve(initial));
  expect(latest!.data?.generatedAt).toBe(newer.generatedAt);

  await settle(() => changeSession(1));
  expect(harness.requests[0]!.signal?.aborted).toBe(true);
  expect(harness.listeners.size).toBe(1);
  const epochBeforeReset = latest!.epoch;
  await settle(() => harness.emit({ type: "reset", reason: "Stream session changed" }));
  expect(latest!.data).toBeNull();
  expect(latest!.epoch).toBeGreaterThan(epochBeforeReset);
  expect(harness.requests[1]!.signal?.aborted).toBe(true);
  await settle(() => harness.requests[1]!.resolve(newer));
  expect(latest!.data).toBeNull();
  expect(harness.requests).toHaveLength(3);
  await settle(() => harness.requests[2]!.resolve(initial));
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  await settle(() => harness.emit({ type: "data", payload: initial }));
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  await settle(() => harness.emit({ type: "disconnected", reason: "Stream disconnected" }));
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  expect(latest!.transport).toBe("Stream disconnected");

  await settle(() => changeSession(2));
  await act(async () => setup!.renderer.destroy()); setup = undefined;
  expect(harness.listeners.size).toBe(0);
  expect(harness.requests[3]!.signal?.aborted).toBe(true);
  harness.requests[3]!.resolve(newer);
});

test("failed manual refresh keeps the dated tape while a changed account clears it", async () => {
  const harness = clientHarness();
  let latest: ReturnType<typeof useTape>;
  let refresh: () => void = () => {};
  let changeSession: () => void = () => {};
  function Probe() {
    const [session, setSession] = useState(0);
    const [revision, setRevision] = useState(0);
    refresh = () => setRevision((value) => value + 1);
    changeSession = () => setSession((value) => value + 1);
    latest = useTape("AAPL", "NASDAQ", session, revision, harness.client);
    return <Text>{latest.data?.generatedAt ?? "empty"}</Text>;
  }
  setup = await testRender(<Probe />, { width: 50, height: 3 });
  await settle();
  const initial = tapeFixture();
  await settle(() => harness.requests[0]!.resolve(initial));
  await settle(refresh);
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  expect(latest!.loading).toBe(true);
  await settle(() => harness.requests[1]!.reject(new Error("Refresh unavailable")));
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  expect(latest!.error).toBe("Refresh unavailable");
  expect(latest!.loading).toBe(false);
  await settle(changeSession);
  expect(latest!.data).toBeNull();
});
