import { expect, test } from "bun:test";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { ScreenCheckPayload, ScreenDefinition } from "../../../api-client/equity-screener";
import { ApiRequestError } from "../../../api-client/errors";
import { ScreenTickerCheck } from "./ticker-check";
import { screenFixture } from "./test-fixture";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";

const tui = createOpenTuiTestHarness({ width: 120, height: 20 });
const definition: ScreenDefinition = {
  version: 1,
  currency: "USD",
  criteria: [{ field: "trailingPE", op: "lte", value: 30 }],
  sort: { field: "marketCap", direction: "desc" },
};
function result(symbol: string): ScreenCheckPayload {
  return {
    version: 1, status: "available", symbol, definition,
    snapshot: screenFixture().snapshot!, matches: false,
    row: { symbol, exchange: "NASDAQ", name: `${symbol} check result`, currency: "USD", sector: null, industry: null },
    criteria: [
      { criterion: { field: "currency", op: "in", value: ["USD"] }, implicit: true, value: "USD", passes: true, state: "available", unit: "", asOf: null, observedAt: null, reason: null },
      { criterion: definition.criteria[0]!, implicit: false, value: 42, passes: false, state: "available", unit: "x", asOf: "2026-10-22", observedAt: null, reason: null },
    ],
    warnings: [],
  };
}

test.each(["before", "after"])("checking another ticker cancels the old decision, ignores its late answer and clears access-denied refresh data (old reply %s new reply)", async (oldReplyOrder) => {
  const requests: Array<{
    symbol: string;
    snapshotId?: string;
    signal?: AbortSignal;
    resolve: (value: ScreenCheckPayload) => void;
    reject: (error: unknown) => void;
  }> = [];
  const fetcher = (_definition: ScreenDefinition, symbol: string, snapshotId?: string, signal?: AbortSignal) => {
    const { promise, resolve, reject } = Promise.withResolvers<ScreenCheckPayload>();
    requests.push({ symbol, snapshotId, signal, resolve, reject });
    return promise;
  };
  const paint = async () => {
    // act commits React updates; paint afterward before reading the terminal.
    await tui.setup().renderOnce();
    return tui.frame();
  };
  const answer = async (index: number, symbol: string) => {
    await act(async () => { requests[index]!.resolve(result(symbol)); });
    return paint();
  };
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, createInitialState(createTestPaneConfig("/tmp/eqs-check-test", { instanceId: "eqs:test", paneId: "equity-screener", binding: { kind: "none" } })));
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="eqs:test" pluginId="research" runtime={runtime} width={120} height={20} footerKeys>
      {(body) => <ScreenTickerCheck definition={definition} snapshotId="one" {...body} focused fetcher={fetcher} />}
    </TestPaneFrame>;
  }
  await act(async () => {
    await tui.render(<Harness />);
  });
  await act(async () => { await tui.setup().mockInput.typeText("NVDA"); tui.setup().mockInput.pressEnter(); });
  expect(await paint()).toContain("Loading ticker check");
  expect(requests[0]?.symbol).toBe("NVDA");
  expect(requests[0]?.snapshotId).toBe("one");
  await tui.clickFrameText("Ticker");
  await tui.emitKeypress({ name: "escape" });
  await paint();
  await tui.clickFrameText("Ticker");
  await act(async () => { await tui.setup().mockInput.typeText("MSFT"); tui.setup().mockInput.pressEnter(); });
  expect(requests[0]?.signal?.aborted).toBe(true);
  expect(requests[1]?.symbol).toBe("MSFT");
  expect(await paint()).toContain("Loading ticker check");
  if (oldReplyOrder === "before") {
    const pendingFrame = await answer(0, "NVDA");
    expect(pendingFrame).toContain("Loading ticker check");
    // The input placeholder also names NVDA:NASDAQ; inspect result content.
    expect(pendingFrame).not.toContain("NVDA check result");
  }
  let frame = await answer(1, "MSFT");
  if (oldReplyOrder === "after") {
    expect(frame).toContain("MSFT check result");
    frame = await answer(0, "NVDA");
  }
  expect(frame).toContain("MSFT:NASDAQ");
  expect(frame).toContain("MSFT check result");
  expect(frame).not.toContain("NVDA check result");
  expect(frame).toContain("Does not match");
  expect(frame).toContain("Trailing P/E <= 30");
  expect(frame).toContain("42 x");
  expect(frame).toContain("Fail");
  await tui.emitKeypress({ name: "r" });
  await act(async () => { requests[2]!.reject(new ApiRequestError("This screen needs Gloom Pro.", 403)); });
  const deniedFrame = await paint();
  expect(deniedFrame).toContain("This screen needs Gloom Pro.");
  expect(deniedFrame).not.toContain("MSFT check result");
  await tui.emitKeypress({ name: "r" });
  await tui.destroy();
  expect(requests[3]?.signal?.aborted).toBe(true);
});
