import { expect, test } from "bun:test";
import { CapabilityRegistry } from "../../../../capabilities";
import { desktopRendererCapabilityManifests } from "./initialization";

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
