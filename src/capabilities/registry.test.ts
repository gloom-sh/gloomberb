import { describe, expect, test } from "bun:test";
import { chartSeriesProvider } from "./factories";
import { CapabilityRegistry } from "./registry";
import { ConnectionHealthRegistry } from "../core/connection-health";
import type { CapabilitySchema, PluginCapability } from "./types";

interface IncrementInput {
  value: number;
}

const incrementSchema: CapabilitySchema<IncrementInput> = {
  parse(value) {
    if (!value || typeof value !== "object" || typeof (value as any).value !== "number") {
      throw new Error("Expected numeric value.");
    }
    return value as IncrementInput;
  },
};

function testCapability(overrides: Partial<PluginCapability> = {}): PluginCapability {
  return {
    id: "plugin-service.test",
    kind: "plugin-service",
    name: "Test Capability",
    operations: {
      increment: {
        kind: "read",
        rendererSafe: true,
        input: incrementSchema,
        handler: (input: IncrementInput) => input.value + 1,
      },
      privateRead: {
        kind: "read",
        rendererSafe: false,
        handler: () => "private",
      },
    },
    ...overrides,
  };
}

describe("CapabilityRegistry", () => {
  test("registers capabilities and rejects duplicate ids", () => {
    const registry = new CapabilityRegistry();
    const dispose = registry.register("plugin-a", testCapability());

    expect(registry.list().map((entry) => entry.capability.id)).toEqual(["plugin-service.test"]);
    expect(() => registry.register("plugin-b", testCapability())).toThrow("already registered");

    dispose();
    expect(registry.list()).toEqual([]);

    registry.register("plugin-b", testCapability());
    dispose();
    expect(registry.list()).toHaveLength(1);
  });

  test("filters disabled plugins and disabled capabilities", () => {
    const registry = new CapabilityRegistry({
      isPluginEnabled: (pluginId) => pluginId !== "disabled-plugin",
      isCapabilityEnabled: (capability) => capability.sourceId !== "disabled-source",
    });

    registry.register("disabled-plugin", testCapability({ id: "plugin-service.disabled-plugin" }));
    registry.register("enabled-plugin", testCapability({
      id: "plugin-service.disabled-source",
      sourceId: "disabled-source",
    }));
    registry.register("enabled-plugin", testCapability({ id: "plugin-service.enabled" }));

    expect(registry.list().map((entry) => entry.capability.id)).toEqual(["plugin-service.enabled"]);
  });

  test("enforces renderer safety and input schemas on invoke", async () => {
    const registry = new CapabilityRegistry();
    registry.register("plugin-a", testCapability());

    await expect(registry.invoke("plugin-service.test", "privateRead", {}, { renderer: true }))
      .rejects.toThrow("not available to renderers");
    await expect(registry.invoke("plugin-service.test", "increment", { value: "1" }, { renderer: true }))
      .rejects.toThrow("Expected numeric value");

    await expect(registry.invoke("plugin-service.test", "increment", { value: 1 }, { renderer: true }))
      .resolves.toBe(2);
  });

  test("reports invokable provider operations through the connection boundary", async () => {
    let clock = 10;
    const health = new ConnectionHealthRegistry({ clock: () => clock });
    health.registerSource({ id: "asset-data.test", name: "Test", kind: "asset-data" });
    const registry = new CapabilityRegistry({ connectionHealth: health });
    registry.register("plugin-a", testCapability({
      id: "asset-data.test",
      kind: "asset-data",
      operations: {
        read: {
          kind: "read",
          handler: async () => {
            clock = 16;
            return "ok";
          },
        },
      },
    }));

    await expect(registry.invoke("asset-data.test", "read", {})).resolves.toBe("ok");
    expect(health.getSnapshot().sources[0]).toMatchObject({
      status: "connected",
      lastOperation: "read",
      lastLatencyMs: 6,
    });
  });

  test("does not treat cached and static capability operations as network health", async () => {
    const health = new ConnectionHealthRegistry();
    health.registerSource({ id: "asset-data.test", name: "Test", kind: "asset-data" });
    const registry = new CapabilityRegistry({ connectionHealth: health });
    registry.register("plugin-a", testCapability({
      id: "asset-data.test",
      kind: "asset-data",
      operations: Object.fromEntries([
        "canProvide",
        "getCachedFinancialsForTargets",
        "getChartResolutionSupport",
      ].map((id) => [id, { kind: "read", handler: () => true }])),
    }));

    await registry.invoke("asset-data.test", "canProvide", {});
    await registry.invoke("asset-data.test", "getCachedFinancialsForTargets", {});
    await registry.invoke("asset-data.test", "getChartResolutionSupport", {});

    expect(health.getSnapshot().sources[0]).toMatchObject({ status: "idle", lastRequestAt: null });
  });

  test("emits renderer-safe manifests only when requested", () => {
    const registry = new CapabilityRegistry();
    registry.register("plugin-a", testCapability());

    expect(registry.manifests({ rendererOnly: true })[0]?.operations.map((operation) => operation.id))
      .toEqual(["increment"]);
    expect(registry.manifests()[0]?.operations.map((operation) => operation.id))
      .toEqual(["increment", "privateRead"]);
  });

  test("subscribes, unsubscribes, and cleans up subscriptions on unregister", async () => {
    const registry = new CapabilityRegistry();
    const events: string[] = [];
    let disposed = 0;

    const disposeCapability = registry.register("plugin-a", testCapability({
      id: "plugin-service.streams",
      operations: {
        ticks: {
          kind: "stream",
          rendererSafe: true,
          subscribe: (input: any, emit) => {
            emit(input.value);
            return () => {
              disposed += 1;
            };
          },
        },
      },
    }));

    const subscriptionId = await registry.subscribe<string>(
      "plugin-service.streams",
      "ticks",
      { value: "first" },
      (event) => events.push(event),
      { renderer: true },
    );

    expect(events).toEqual(["first"]);
    registry.unsubscribe(subscriptionId);
    expect(disposed).toBe(1);

    await registry.subscribe<string>(
      "plugin-service.streams",
      "ticks",
      { value: "second" },
      (event) => events.push(event),
      { renderer: true, subscriptionId: "renderer:quote:1" },
    );
    disposeCapability();

    expect(events).toEqual(["first", "second"]);
    expect(disposed).toBe(2);
    expect(registry.list()).toEqual([]);
  });

  test("registers, searches, resolves, disables, and disposes chart-series providers", async () => {
    let enabled = true;
    const registry = new CapabilityRegistry({ isPluginEnabled: () => enabled });
    const dispose = registry.register("charts", chartSeriesProvider({
      id: "charts.test",
      name: "Test Charts",
      provider: {
        search: ({ query }) => [{ seriesId: "one", label: `Result ${query}` }],
        resolve: ({ seriesId }) => ({
          id: seriesId,
          label: "Resolved",
          color: "#fff",
          unit: "value",
          unitGroup: "value",
          nativeFrequency: "daily",
          dataShape: "scalar",
          style: "line",
          transform: "raw",
          axis: "left",
          panelId: "main",
          interpolation: "none",
          points: [{ date: new Date("2026-01-01"), observedAt: new Date("2026-01-01"), value: 1 }],
        }),
      },
    }));

    await expect(registry.invoke<any[]>("charts.test", "search", { query: "x" }))
      .resolves.toEqual([{ seriesId: "one", label: "Result x" }]);
    await expect(registry.invoke<any>("charts.test", "resolve", {
      seriesId: "one",
      viewport: { range: "1M", resolution: "auto" },
    })).resolves.toMatchObject({ id: "one", points: [{ value: 1 }] });

    enabled = false;
    expect(registry.list("chart-series")).toEqual([]);
    await expect(registry.invoke("charts.test", "search", {})).rejects.toThrow("not available");
    enabled = true;
    dispose();
    await expect(registry.invoke("charts.test", "search", {})).rejects.toThrow("not available");
  });

  test("disposes subscriptions that finish after their capability is removed", async () => {
    const registry = new CapabilityRegistry();
    let finishSubscribe!: (dispose: () => void) => void;
    let disposed = 0;
    const disposeCapability = registry.register("plugin-a", testCapability({
      operations: {
        ticks: {
          kind: "stream",
          subscribe: () => new Promise((resolve) => { finishSubscribe = resolve; }),
        },
      },
    }));

    const subscribing = registry.subscribe("plugin-service.test", "ticks", {}, () => {});
    disposeCapability();
    finishSubscribe(() => { disposed += 1; });

    await expect(subscribing).rejects.toThrow("not available");
    expect(disposed).toBe(1);
  });
});
