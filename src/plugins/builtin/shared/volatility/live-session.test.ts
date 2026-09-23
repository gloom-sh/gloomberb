import { afterEach, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { setAppVisible } from "../../../../state/app/activity";
import { useLiveSessionRefresh, usOptionsSession } from "./live-session";

const realNow = Date.now;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  Date.now = realNow;
  setAppVisible(true);
});

test("the options session follows published hours, early closes and holidays", () => {
  const at = (iso: string) => usOptionsSession(Date.parse(iso));
  // Wednesday 2026-09-23, 11:00 New York.
  expect(at("2026-09-23T15:00:00Z")).toEqual({ open: true, nextChangeAt: Date.parse("2026-09-23T20:00:00Z") });
  expect(at("2026-09-23T13:00:00Z")).toEqual({ open: false, nextChangeAt: Date.parse("2026-09-23T13:30:00Z") });
  // After the close the next change is the following morning's open.
  expect(at("2026-09-23T20:00:00Z")).toEqual({ open: false, nextChangeAt: Date.parse("2026-09-24T13:30:00Z") });
  // Saturday waits for Monday.
  expect(at("2026-09-26T15:00:00Z").nextChangeAt).toBe(Date.parse("2026-09-28T13:30:00Z"));
  // Thanksgiving is closed; the day after closes at 13:00.
  expect(at("2026-11-26T16:00:00Z")).toEqual({ open: false, nextChangeAt: Date.parse("2026-11-27T14:30:00Z") });
  expect(at("2026-11-27T17:30:00Z")).toEqual({ open: true, nextChangeAt: Date.parse("2026-11-27T18:00:00Z") });
  expect(at("2026-11-27T18:30:00Z").open).toBe(false);
});

async function renderRefresh(now: number, enabled = true) {
  Date.now = () => now;
  let calls = 0;
  let active = false;
  function Probe() {
    active = useLiveSessionRefresh(() => { calls += 1; }, 20, enabled);
    return null;
  }
  await act(async () => { setup = await testRender(createElement(Probe), { width: 10, height: 2 }); });
  const wait = async (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  return { calls: () => calls, active: () => active, wait };
}

test("refreshes only while visible, enabled and in session, and never on mount", async () => {
  const open = await renderRefresh(Date.parse("2026-09-23T15:00:00Z"));
  expect(open.calls()).toBe(0);
  expect(open.active()).toBe(true);
  await open.wait(70);
  expect(open.calls()).toBeGreaterThanOrEqual(2);
  await act(async () => setAppVisible(false));
  const hidden = open.calls();
  await open.wait(70);
  expect(open.calls()).toBe(hidden);
  expect(open.active()).toBe(false);
  await act(async () => setup!.renderer.destroy());
  setup = undefined;

  const closed = await renderRefresh(Date.parse("2026-09-23T21:00:00Z"));
  await closed.wait(70);
  expect(closed.calls()).toBe(0);
  expect(closed.active()).toBe(false);
  await act(async () => setup!.renderer.destroy());
  setup = undefined;

  const disabled = await renderRefresh(Date.parse("2026-09-23T15:00:00Z"), false);
  await disabled.wait(70);
  expect(disabled.calls()).toBe(0);
});

test("a cycle enabled by a slow load waits an interval; returning from a long hidden stretch fires at once", async () => {
  let now = Date.parse("2026-09-23T15:00:00Z");
  Date.now = () => now;
  let calls = 0;
  let setProps!: (next: { enabled: boolean; loadedAt: number | null }) => void;
  function Probe() {
    const [props, set] = useState<{ enabled: boolean; loadedAt: number | null }>({ enabled: false, loadedAt: null });
    setProps = set;
    useLiveSessionRefresh(() => { calls += 1; }, 1_000, props.enabled, props.loadedAt);
    return null;
  }
  await act(async () => { setup = await testRender(createElement(Probe), { width: 10, height: 2 }); });
  // The first load outlasted the interval; its own data is the latest refresh.
  now += 5_000;
  await act(async () => setProps({ enabled: true, loadedAt: now }));
  expect(calls).toBe(0);
  await act(async () => setAppVisible(false));
  now += 5_000;
  await act(async () => setAppVisible(true));
  expect(calls).toBe(1);
});
