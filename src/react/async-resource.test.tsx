import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { useAsyncResource } from "./async-resource";
import { connectionHealth, GLOOM_CLOUD_HTTP_CONNECTION_ID, registerGloomCloudConnectionSources } from "../core/connection-health";
import { MemoryResourceStore } from "../data/memory-resource-store";
import { setSavedCopyFrameGate, setSavedCopyStore, writeSavedCopy } from "../data/pane-saved-copies";
import { Text } from "../ui";
import { apiClient } from "../api-client";
import { useCloudDisplayScope } from "../api-client/plan-access";

type Loader = ((force: boolean) => Promise<string>) | null;
const tui = createOpenTuiTestHarness({ width: 20, height: 5 });
let resource: ReturnType<typeof useAsyncResource<string>>;
let changeLoader: (next: Loader) => void;

async function mount(
  loader: Loader,
  clearOnError: boolean | ((error: unknown) => boolean) = false,
  keepPreviousData = false,
) {
  function Probe() {
    const [request, setRequest] = useState(() => loader);
    changeLoader = (next) => setRequest(() => next);
    resource = useAsyncResource(request, { clearOnError, keepPreviousData });
    return null;
  }
  await tui.render(<Probe />);
  await act(async () => { await tui.setup().renderOnce(); });
}

test("only the newest request may publish data or an error", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const forces: boolean[] = [];
  await mount((force) => {
    forces.push(force);
    return force ? second.promise : first.promise;
  });
  let refresh: Promise<void>;
  await act(async () => { refresh = resource.reloadAndWait(); });
  await act(async () => { second.resolve("new"); await refresh; });
  await act(async () => { first.reject(new Error("old failure")); });
  expect(forces).toEqual([false, true]);
  expect(resource).toMatchObject({ data: "new", loading: false, error: null });
});

test("terminal draws the saved result before starting its background refresh", async () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const savedCopy = { key: ["board", "NYSE"] };
  const pending = Promise.withResolvers<string>();
  const drawn = Promise.withResolvers<void>();
  const loads: boolean[] = [];
  const loader = (force: boolean) => { loads.push(force); return pending.promise; };
  const rendered: string[] = [];
  function Pane() {
    const view = useAsyncResource(loader, { savedCopy });
    const text = view.loading ? "Loading" : view.data ?? "Empty";
    rendered.push(text);
    return <Text>{text}</Text>;
  }
  try {
    setSavedCopyFrameGate(() => drawn.promise);
    writeSavedCopy(savedCopy, "Old rows", Date.UTC(2023, 0, 1));
    await tui.render(<Pane />);
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).toContain("Old rows");
    expect(loads).toEqual([]);
    await act(async () => { drawn.resolve(); });
    expect(loads).toEqual([true]);
    await act(async () => { pending.resolve("New rows"); });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).toContain("New rows");
    expect(rendered).not.toContain("Loading");
  } finally {
    setSavedCopyFrameGate(null);
    setSavedCopyStore(previous);
  }
});

test("terminal starts a cold load even if the saved-copy frame has not drawn", async () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const savedCopy = { key: ["board", "NYSE"] };
  const drawn = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<string>();
  const loads: boolean[] = [];
  const loader = (force: boolean) => { loads.push(force); return pending.promise; };
  function Pane() {
    const view = useAsyncResource(loader, { savedCopy });
    return <Text>{view.loading ? "Loading" : view.data ?? "Empty"}</Text>;
  }
  try {
    setSavedCopyFrameGate(() => drawn.promise);
    await tui.render(<Pane />);
    expect(loads).toEqual([false]);
    await act(async () => { pending.resolve("Live rows"); });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).toContain("Live rows");
  } finally {
    drawn.resolve();
    setSavedCopyFrameGate(null);
    setSavedCopyStore(previous);
  }
});

test("an unchanged refresh keeps the display data stable without keeping the saved age", async () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const savedCopy = { key: ["history", "NYSE", "public"] };
  const live = { rows: [{ date: new Date("2026-01-01"), value: 42 }] };
  const pending = Promise.withResolvers<typeof live>();
  const loader = () => pending.promise;
  let view: ReturnType<typeof useAsyncResource<typeof live>> | undefined;
  function Pane() {
    view = useAsyncResource(loader, { savedCopy });
    return null;
  }
  try {
    const fetchedAt = Date.UTC(2026, 0, 1);
    writeSavedCopy(savedCopy, live, fetchedAt);
    await tui.render(<Pane />);
    const opening = view?.data;
    expect(opening).toEqual(live);
    expect(view?.savedAt).toBe(fetchedAt);
    await act(async () => { pending.resolve(live); });
    expect(view?.data).toBe(opening);
    expect(view?.savedAt).toBeNull();
    expect(view?.updatedAt).toBeGreaterThan(fetchedAt);
  } finally {
    setSavedCopyStore(previous);
  }
});

test("a saved result renders before the live request has its inputs", async () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const savedCopy = { key: ["surface", "SPY", "ARCA"] };
  const forces: boolean[] = [];
  const loader = async (force: boolean) => { forces.push(force); return "Live surface"; };
  let ready!: (value: boolean) => void;
  function Pane() {
    const [canLoad, setCanLoad] = useState(false);
    ready = setCanLoad;
    const view = useAsyncResource(loader, { savedCopy, deferLoad: !canLoad });
    return <Text>{view.loading ? "Loading" : view.data}</Text>;
  }
  try {
    writeSavedCopy(savedCopy, "Saved surface", Date.UTC(2023, 0, 1));
    await tui.render(<Pane />);
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).toContain("Saved surface");
    expect(forces).toEqual([]);
    await act(async () => { ready(true); });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(tui.frame()).toContain("Live surface");
    expect(forces).toEqual([true]);
  } finally {
    setSavedCopyStore(previous);
  }
});

test("a deferred cache miss stays idle, even on manual refresh", async () => {
  let requests = 0;
  const loader = async () => { requests += 1; return "Unexpected result"; };
  function Probe() {
    resource = useAsyncResource(loader, { savedCopy: { key: ["deferred-miss"] }, deferLoad: true });
    return null;
  }
  await tui.render(<Probe />);
  await act(async () => { await resource.reloadAndWait(); });
  expect(resource).toMatchObject({ data: null, loading: false, refreshing: false, status: "idle" });
  expect(requests).toBe(0);
});

test("listing changes prefer an exact saved copy, then same-access previous data, never another scope", async () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const answer = Promise.withResolvers<string>();
  const loader = () => answer.promise;
  const pro = { id: "fixture-first", email: "first@example.com", emailVerified: true, plan: "pro" as const };
  let changeListing!: (value: string) => void;
  function Probe() {
    const [listing, setListing] = useState("SPY:ARCX");
    changeListing = setListing;
    const scope = useCloudDisplayScope();
    resource = useAsyncResource(scope ? loader : null, {
      keepPreviousData: scope,
      savedCopy: scope ? { key: ["test-history", scope, listing] } : null,
    });
    return null;
  }
  try {
    apiClient.setSessionToken("isolated-snapshot-fixture");
    apiClient.restoreCachedUser(pro);
    const scope = JSON.stringify([pro.id, true, true]);
    writeSavedCopy({ key: ["test-history", scope, "SPY:ARCX"] }, "Saved SPY");
    writeSavedCopy({ key: ["test-history", scope, "QQQ:XNAS"] }, "Saved QQQ");
    writeSavedCopy({ key: ["test-history", "QQQ:XNAS"] }, "Legacy unscoped data");
    await tui.render(<Probe />);
    expect(resource.data).toBe("Saved SPY");
    await act(async () => { changeListing("QQQ:XNAS"); });
    expect(resource.data).toBe("Saved QQQ");
    await act(async () => { changeListing("QQQ:XNYS"); });
    expect(resource.data).toBe("Saved QQQ");
    await act(async () => { apiClient.restoreCachedUser({ ...pro, plan: "free" }); });
    expect(resource.data).toBeNull();
    await act(async () => { apiClient.restoreCachedUser(pro); });
    await act(async () => { changeListing("QQQ:XNAS"); });
    expect(resource.data).toBe("Saved QQQ");
    await act(async () => { apiClient.restoreCachedUser({ ...pro, id: "fixture-second" }); });
    expect(resource.data).toBeNull();
    await act(async () => { apiClient.setSessionToken(null); });
    expect(resource.data).toBeNull();
  } finally {
    apiClient.setSessionToken(null);
    setSavedCopyStore(previous);
  }
});

test("reload starts a forced load and returns nothing; reloadAndWait settles once the answer or failure is in", async () => {
  const forces: boolean[] = [];
  let answer = Promise.withResolvers<string>();
  await mount((force) => {
    forces.push(force);
    return answer.promise;
  });
  await act(async () => { answer.resolve("first"); });
  answer = Promise.withResolvers<string>();
  let started: unknown = null;
  await act(async () => { started = resource.reload(); });
  expect(started).toBeUndefined();
  expect(resource.loading).toBe(true);
  await act(async () => { answer.resolve("second"); });
  expect(resource).toMatchObject({ data: "second", loading: false });

  answer = Promise.withResolvers<string>();
  let settled = false;
  let waiting!: Promise<void>;
  await act(async () => { waiting = resource.reloadAndWait().then(() => { settled = true; }); });
  expect(settled).toBe(false);
  await act(async () => {
    answer.reject(new Error("offline"));
    await waiting;
  });
  expect(settled).toBe(true);
  expect(resource).toMatchObject({ data: "second", loading: false, error: "offline" });
  expect(forces).toEqual([false, true, true]);
});

test("changing, disabling, and unmounting a resource invalidate pending work", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  await mount(() => first.promise);
  await act(async () => { changeLoader(() => second.promise); });
  await act(async () => { first.resolve("previous ticker"); });
  expect(resource.data).toBeNull();
  await act(async () => { changeLoader(null); });
  await act(async () => { second.resolve("cleared ticker"); });
  expect(resource).toMatchObject({ data: null, loading: false, error: null, status: "idle" });

  const third = Promise.withResolvers<string>();
  await act(async () => { changeLoader(() => third.promise); });
  const beforeUnmount = resource;
  await tui.destroy();
  await act(async () => { third.resolve("unmounted"); });
  expect(resource).toBe(beforeUnmount);
});

test.each([false, true])("refresh failure clears data only when configured: %s", async (clearOnError) => {
  await mount(async (force) => {
    if (force) throw new Error("");
    return "cached";
  }, clearOnError);
  await act(async () => {
    await resource.reloadAndWait();
  });
  expect(resource).toMatchObject({
    data: clearOnError ? null : "cached",
    loading: false,
    error: "Request failed",
    status: "error",
  });
});

test("a new security cannot display the previous security's loaded data while pending or failed", async () => {
  await mount(async () => "AAPL history");
  expect(resource.data).toBe("AAPL history");
  const next = Promise.withResolvers<string>();
  await act(async () => { changeLoader(() => next.promise); });
  expect(resource).toMatchObject({ data: null, updatedAt: null, loading: true, error: null });
  await act(async () => { next.reject(new Error("MSFT unavailable")); });
  expect(resource).toMatchObject({ data: null, updatedAt: null, loading: false, error: "MSFT unavailable" });
});

test("keepPreviousData leaves the last answer up while a new loader loads and fails, and null still clears", async () => {
  await mount(async () => "AAPL peers", false, true);
  const loadedAt = resource.updatedAt;
  const next = Promise.withResolvers<string>();
  await act(async () => { changeLoader(() => next.promise); });
  expect(resource).toMatchObject({ data: "AAPL peers", updatedAt: loadedAt, loading: true, error: null });
  await act(async () => { next.reject(new Error("MSFT unavailable")); });
  expect(resource).toMatchObject({ data: "AAPL peers", loading: false, error: "MSFT unavailable" });
  await act(async () => { changeLoader(null); });
  expect(resource).toMatchObject({ data: null, loading: false, error: null, status: "idle" });
});

test("error policy retains the original retrieval time through an outage and clears it with denied data", async () => {
  let failure: Error | null = null;
  const seen: unknown[] = [];
  await mount(async () => {
    if (failure) throw failure;
    return "known research";
  }, (error) => {
    seen.push(error);
    return error instanceof Error && error.message === "Access denied";
  });
  const retrievedAt = resource.updatedAt;
  expect(retrievedAt).not.toBeNull();
  const outage = new DOMException("Provider timed out", "TimeoutError");
  failure = outage;
  await act(async () => { await resource.reloadAndWait(); });
  expect(resource).toMatchObject({ data: "known research", updatedAt: retrievedAt, savedAt: retrievedAt, error: outage.message });
  const denial = new Error("Access denied");
  failure = denial;
  await act(async () => { await resource.reloadAndWait(); });
  expect(resource).toMatchObject({ data: null, updatedAt: null, error: denial.message });
  expect(seen).toEqual([outage, denial]);
});

test("an inline error predicate neither reloads nor loops across renders", async () => {
  let calls = 0;
  let rerender: () => void = () => {};
  const request = async () => { calls++; return "loaded"; };
  function Probe() {
    const [, setTick] = useState(0);
    rerender = () => setTick((tick) => tick + 1);
    resource = useAsyncResource(request, { clearOnError: (error) => error instanceof Error });
    return null;
  }
  await tui.render(<Probe />);
  await act(async () => { await tui.setup().renderOnce(); });
  await act(async () => { rerender(); await tui.setup().renderOnce(); });
  await act(async () => { rerender(); await tui.setup().renderOnce(); });
  expect(calls).toBe(1);
  expect(resource.data).toBe("loaded");
});

// A pane whose load failed in an outage kept its failure after the network
// came back, until the user refreshed it by hand.
test("a load that failed is asked again once the data service answers after an outage", async () => {
  const disposeSources = registerGloomCloudConnectionSources(connectionHealth);
  try {
    let online = false;
    let asked = 0;
    await mount(async () => {
      asked += 1;
      if (!online) throw new Error("Gloom couldn't reach its data service");
      return "board";
    });
    expect(resource).toMatchObject({ data: null, error: "Gloom couldn't reach its data service" });

    connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, false);
    online = true;
    await act(async () => { connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, true); });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(asked).toBe(2);
    expect(resource).toMatchObject({ data: "board", error: null });

    // A resource that answered is left alone by the next recovery.
    connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, false);
    await act(async () => { connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, true); });
    expect(asked).toBe(2);
  } finally {
    disposeSources();
  }
});

test("recovery revalidates a retained copy even if the cache still considers it fresh", async () => {
  const disposeSources = registerGloomCloudConnectionSources(connectionHealth);
  try {
    let online = false;
    await mount(async (force) => {
      if (!force) return "cached board";
      if (!online) throw new DOMException("Provider timed out", "TimeoutError");
      return "fresh board";
    });
    const savedAt = resource.updatedAt;
    await act(async () => { await resource.reloadAndWait(); });
    expect(resource).toMatchObject({ data: "cached board", savedAt });

    online = true;
    await act(async () => {
      connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, false);
      connectionHealth.reportReachability(GLOOM_CLOUD_HTTP_CONNECTION_ID, true);
    });
    await act(async () => { await tui.setup().renderOnce(); });
    expect(resource).toMatchObject({ data: "fresh board", savedAt: null, error: null });
  } finally {
    disposeSources();
  }
});
