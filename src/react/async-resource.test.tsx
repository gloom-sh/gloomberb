import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { useAsyncResource } from "./async-resource";

type Loader = ((force: boolean) => Promise<string>) | null;
let setup: Awaited<ReturnType<typeof testRender>>;
let resource: ReturnType<typeof useAsyncResource<string>>;
let changeLoader: (next: Loader) => void;

afterEach(() => setup?.renderer.destroy());

async function mount(loader: Loader, clearOnError = false) {
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
  await mount(async () => "cached", clearOnError);
  await act(async () => {
    changeLoader(() => { throw new Error(""); });
  });
  expect(resource).toMatchObject({
    data: clearOnError ? null : "cached",
    loading: false,
    error: "",
    status: "error",
  });
});
