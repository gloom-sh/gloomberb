import { afterEach, expect, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { PaneInViewProvider, setAppVisible } from "../../../state/app/activity";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { Text } from "../../../ui";
import { useAutoRefresh } from "./auto-refresh";

const state = createInitialState({ ...createDefaultConfig("/tmp/auto-refresh-unused"), refreshIntervalMinutes: 30 });

let refreshCalls: number[] = [];
let setInView: (inView: boolean) => void = () => {};

/** A pane whose load lands `loadMs` after the refresh that started it. */
function Probe({ intervalMs, loadMs, succeeds = true }: { intervalMs: number; loadMs: number; succeeds?: boolean }) {
  const [lastUpdated, setLastUpdated] = useState<number | null>(() => Date.now());
  const refresh = useCallback(() => {
    refreshCalls.push(Date.now());
    if (!succeeds) return;
    setTimeout(() => setLastUpdated(Date.now()), loadMs);
  }, [loadMs, succeeds]);
  useAutoRefresh(lastUpdated, refresh, { intervalMs });
  return <Text>{String(lastUpdated)}</Text>;
}

function Harness(props: { intervalMs: number; loadMs: number; succeeds?: boolean }) {
  const [inView, setInViewState] = useState(true);
  setInView = setInViewState;
  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInViewProvider value={inView}>
        <Probe {...props} />
      </PaneInViewProvider>
    </AppContext>
  );
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  refreshCalls = [];
  setAppVisible(true);
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
});

async function mount(props: { intervalMs: number; loadMs: number; succeeds?: boolean }) {
  await act(async () => {
    setup = await testRender(<Harness {...props} />, { width: 20, height: 1 });
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await setup!.renderOnce();
  });
}

test("schedules each refresh one interval after the data landed, not on a free-running clock", async () => {
  // A free-running check fires just before a slow load's data turns one
  // interval old, skips it, and only refreshes on the tick after: the data
  // ages to twice the interval.
  await mount({ intervalMs: 120, loadMs: 30 });
  await wait(460);
  expect(refreshCalls.length).toBeGreaterThanOrEqual(2);
  const gaps = refreshCalls.slice(1).map((at, index) => at - refreshCalls[index]!);
  for (const gap of gaps) expect(gap).toBeLessThan(220);
});

test("a failing refresh retries once per interval instead of spinning", async () => {
  await mount({ intervalMs: 80, loadMs: 0, succeeds: false });
  await wait(300);
  expect(refreshCalls.length).toBeGreaterThanOrEqual(2);
  expect(refreshCalls.length).toBeLessThanOrEqual(4);
});

test("rests while the pane cannot be seen and catches up as soon as it can", async () => {
  await mount({ intervalMs: 100, loadMs: 0 });
  await act(async () => setInView(false));
  await wait(260);
  expect(refreshCalls).toHaveLength(0);

  const shownAt = Date.now();
  await act(async () => setInView(true));
  await wait(40);
  expect(refreshCalls).toHaveLength(1);
  expect(refreshCalls[0]! - shownAt).toBeLessThan(40);

  // A hidden app pauses the same way, whatever the pane's own state.
  await act(async () => setAppVisible(false));
  await wait(260);
  expect(refreshCalls).toHaveLength(1);
});
