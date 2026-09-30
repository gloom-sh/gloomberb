import { expect, test } from "bun:test";
import { act, useState } from "react";
import { ApiRequestError } from "../../../../api-client/errors";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../state/app/context";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestPaneConfig, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import type { PricePoint } from "../../../../types/financials";
import { useRelationshipHistories } from "./history";
import type { RelationshipRange } from "./model";

const tui = createOpenTuiTestHarness();

test("relationship refresh retains a coherent dated pair on outages, discards denied data, and isolates new windows", async () => {
  const values = [100, 110, 105, 112, 104, 115, 120].map((close, i) => ({ date: new Date(Date.UTC(2026, 8, i + 1)), close }));
  let failure: Error | null = null;
  let peerFailure: Error | null = null;
  let pending: ReturnType<typeof Promise.withResolvers<PricePoint[]>> | null = null;
  const calls: unknown[][] = [];
  const provider = createTestDataProvider({
    getPriceHistory: async () => { throw new Error("Automatic chart resolution is not daily history"); },
    getPriceHistoryForResolution: async (...args) => {
      calls.push(args);
      if (args[0] === "SPY:ARCX" && peerFailure) throw peerFailure;
      if (failure) throw failure;
      return pending ? pending.promise : values;
    },
  });
  const state = createInitialState(createTestPaneConfig("/tmp/relationship-history", { instanceId: "pair", paneId: "relationship-graph" }));
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  let resource!: ReturnType<typeof useRelationshipHistories>;
  let changeRange!: (value: RelationshipRange) => void;
  function Probe() {
    const [range, setRange] = useState<RelationshipRange>("1Y");
    changeRange = setRange;
    resource = useRelationshipHistories(["BTC-USD", "SPY:ARCX"], range, "");
    return null;
  }
  await act(async () => {
    await tui.render(<TestPaneProvider state={state} paneId="pair" pluginId="market-overview" runtime={runtime}><Probe /></TestPaneProvider>, { width: 20, height: 5 });
  });
  const first = resource.data;
  const retrieved = resource.updatedAt;
  expect(first).toHaveLength(2);
  expect(calls.map(call => call.slice(2, 4))).toEqual([["1Y", "1d"], ["1Y", "1d"]]);
  failure = new Error("Provider timed out");
  await act(async () => { await resource.reload(); });
  expect(resource).toMatchObject({ data: first, updatedAt: retrieved, error: "BTC-USD: Provider timed out", loading: false });
  expect(calls.at(-1)?.[4]).toEqual({ cacheMode: "refresh" });
  failure = null;
  pending = Promise.withResolvers<PricePoint[]>();
  await act(async () => { changeRange("1M"); });
  expect(resource).toMatchObject({ data: null, loading: true, error: null });
  await act(async () => { pending!.resolve(values.slice(1)); });
  expect(resource.data?.[0]?.points).toHaveLength(6);
  failure = new Error("Provider timed out");
  peerFailure = new ApiRequestError("Listing removed", 404);
  await act(async () => { await resource.reload(); });
  expect(resource).toMatchObject({ data: null, updatedAt: null, error: "SPY:ARCX: Listing removed" });
});
