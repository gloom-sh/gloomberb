import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import type { TapeFeedEvent, TapeSnapshot } from "../../../api-client/tape";
import { tapeFixture } from "./test-fixture";
import { useTape } from "./use-tape";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => { if (setup) await act(async () => setup!.renderer.destroy()); setup = undefined; });

// Keep promises under test control to reproduce a bootstrap overtaken by a socket or auth event.
function clientHarness() {
  const requests: Array<{ signal?: AbortSignal; resolve: (data: TapeSnapshot) => void }> = [];
  const listeners = new Set<(event: TapeFeedEvent) => void>();
  return { requests, listeners, client: {
    getCloudTape: (_symbol: string, _exchange: string, signal?: AbortSignal) => new Promise<TapeSnapshot>((resolve) => requests.push({ signal, resolve })),
    subscribeTape: (_symbol: string, _exchange: string, listener: (event: TapeFeedEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }, emit: (event: TapeFeedEvent) => { for (const listener of listeners) listener(event); } };
}
async function settle(action?: () => void) { await act(async () => { action?.(); await setup!.renderOnce(); }); }

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
  await settle(() => harness.emit({ type: "data", payload: initial }));
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  await settle(() => harness.emit({ type: "disconnected", reason: "Stream disconnected" }));
  expect(latest!.data?.generatedAt).toBe(initial.generatedAt);
  expect(latest!.transport).toBe("Stream disconnected");

  await settle(() => changeSession(2));
  await act(async () => setup!.renderer.destroy()); setup = undefined;
  expect(harness.listeners.size).toBe(0);
  expect(harness.requests[2]!.signal?.aborted).toBe(true);
  harness.requests[2]!.resolve(newer);
});
