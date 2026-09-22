import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { useAsyncResource } from "./async-resource";

type Loader = ((force: boolean) => Promise<string>) | null;
let setup: Awaited<ReturnType<typeof testRender>>;
let resource: ReturnType<typeof useAsyncResource<string>>;
let changeLoader: (next: Loader) => void;

afterEach(() => setup?.renderer.destroy());

async function mount(loader: Loader, clearOnError: boolean | ((error: unknown) => boolean) = false) {
  function Probe() {
    const [request, setRequest] = useState(() => loader);
    changeLoader = (next) => setRequest(() => next);
    resource = useAsyncResource(request, { clearOnError });
    return null;
  }
  setup = await testRender(<Probe />, { width: 20, height: 5 });
  await act(async () => { await setup.renderOnce(); });
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
  await act(async () => { refresh = resource.reload(); });
  await act(async () => { second.resolve("new"); await refresh; });
  await act(async () => { first.reject(new Error("old failure")); });
  expect(forces).toEqual([false, true]);
  expect(resource).toMatchObject({ data: "new", loading: false, error: null });
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
  setup.renderer.destroy();
  await act(async () => { third.resolve("unmounted"); });
  expect(resource).toBe(beforeUnmount);
});

test.each([false, true])("refresh failure clears data only when configured: %s", async (clearOnError) => {
  await mount(async (force) => {
    if (force) throw new Error("");
    return "cached";
  }, clearOnError);
  await act(async () => {
    await resource.reload();
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
  const outage = new Error("Provider timed out");
  failure = outage;
  await act(async () => { await resource.reload(); });
  expect(resource).toMatchObject({ data: "known research", updatedAt: retrievedAt, error: outage.message });
  const denial = new Error("Access denied");
  failure = denial;
  await act(async () => { await resource.reload(); });
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
  setup = await testRender(<Probe />, { width: 20, height: 5 });
  await act(async () => { await setup.renderOnce(); });
  await act(async () => { rerender(); await setup.renderOnce(); });
  await act(async () => { rerender(); await setup.renderOnce(); });
  expect(calls).toBe(1);
  expect(resource.data).toBe("loaded");
});
