import { expect, test } from "bun:test";
import { CapabilityRegistry } from "../../../../capabilities";
import type { AppConfig } from "../../../../types/config";
import type { DesktopBackend } from "./backend";
import { desktopRendererCapabilityManifests, joinDesktopBackendLaunch, startDesktopBackend, type DesktopLaunchSteps } from "./initialization";

test("desktop init includes disabled renderer-safe manifests while invocation stays disabled", async () => {
  let enabled = false;
  const registry = new CapabilityRegistry({ isPluginEnabled: () => enabled });
  registry.register("charts", {
    id: "charts.test",
    kind: "chart-series",
    name: "Test Charts",
    operations: {
      resolve: { kind: "query", rendererSafe: true, handler: () => "ok" },
      private: { kind: "read", handler: () => "private" },
    },
  });

  expect(desktopRendererCapabilityManifests(registry)).toEqual([expect.objectContaining({
    id: "charts.test",
    operations: [expect.objectContaining({ id: "resolve" })],
  })]);
  await expect(registry.invoke("charts.test", "resolve", {}, { renderer: true }))
    .rejects.toThrow("not available");

  enabled = true;
  await expect(registry.invoke("charts.test", "resolve", {}, { renderer: true })).resolves.toBe("ok");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A backend and launch steps that record their order; `services` gates when the services come up. */
function fakeLaunch() {
  const backend = { config: null, services: null } as unknown as DesktopBackend;
  const calls: string[] = [];
  let services = deferred<void>();
  const steps: DesktopLaunchSteps = {
    readConfig: async () => {
      calls.push("readConfig");
      return { dataDir: "/data", layout: "saved" } as unknown as AppConfig;
    },
    restorePlugins: async () => {
      calls.push("restorePlugins");
      return { plugins: "seeded" } as unknown as Partial<AppConfig>;
    },
    startServices: async (config) => {
      calls.push(`startServices:${(config as unknown as { layout: string }).layout}:${(config as unknown as { plugins: string }).plugins}`);
      await services.promise;
      Object.assign(backend, { config, services: {} });
    },
    prefetchPluginBundles: () => { calls.push("prefetchPluginBundles"); },
  };
  return { backend, calls, steps, services: () => services, resetServices: () => { services = deferred<void>(); } };
}

test("desktop launch restores plugins before the services start, then compiles the view's plugins", async () => {
  const launch = fakeLaunch();
  const started = startDesktopBackend(launch.backend, launch.steps);
  await Bun.sleep(0);
  // The view's bundles wait for the services, which import every plugin first.
  expect(launch.calls).toEqual(["readConfig", "restorePlugins", "startServices:saved:seeded"]);
  launch.services().resolve();
  await started;
  expect(launch.calls).toEqual(["readConfig", "restorePlugins", "startServices:saved:seeded", "prefetchPluginBundles"]);
});

test("the window's init shares the launch in flight and skips it once the services are up", async () => {
  const launch = fakeLaunch();
  const atProcessStart = startDesktopBackend(launch.backend, launch.steps);
  const atInit = startDesktopBackend(launch.backend, launch.steps);
  expect(atInit).toBe(atProcessStart);
  launch.services().resolve();
  await Promise.all([atProcessStart, atInit]);
  await startDesktopBackend(launch.backend, launch.steps);
  expect(launch.calls.filter((call) => call === "readConfig")).toHaveLength(1);
});

test("a failed launch, or services torn down by a data reset, start over on the next init", async () => {
  const launch = fakeLaunch();
  const failed = startDesktopBackend(launch.backend, launch.steps);
  launch.services().reject(new Error("disk full"));
  await expect(failed).rejects.toThrow("disk full");

  launch.resetServices();
  const retried = startDesktopBackend(launch.backend, launch.steps);
  launch.services().resolve();
  await retried;
  expect(launch.calls.filter((call) => call === "readConfig")).toHaveLength(2);

  Object.assign(launch.backend, { config: null });
  launch.resetServices();
  launch.services().resolve();
  await startDesktopBackend(launch.backend, launch.steps);
  expect(launch.calls.filter((call) => call === "readConfig")).toHaveLength(3);
});

test("the view's plugin request waits for a launch in flight but never starts one", async () => {
  const launch = fakeLaunch();
  // Services torn down by a config import or a reset, with no launch running.
  let joined = false;
  await joinDesktopBackendLaunch(launch.backend).then(() => { joined = true; });
  expect(joined).toBe(true);
  expect(launch.calls).toEqual([]);

  const started = startDesktopBackend(launch.backend, launch.steps);
  joined = false;
  const joining = joinDesktopBackendLaunch(launch.backend).then(() => { joined = true; });
  await Bun.sleep(0);
  expect(joined).toBe(false);
  // A failed launch is init's to report; the request goes on to collect the bundles.
  launch.services().reject(new Error("disk full"));
  await joining;
  await expect(started).rejects.toThrow("disk full");
  expect(launch.calls.filter((call) => call === "readConfig")).toHaveLength(1);
});
