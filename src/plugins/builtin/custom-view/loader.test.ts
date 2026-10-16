import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../../types/config";
import type { PluginRegistry } from "../../registry";
import { trialLoadViewSource } from "./loader";
import { normalizeViewSpec } from "./view-spec";

function registryWith(load: () => Promise<{ rows: Array<Record<string, unknown>> }>): PluginRegistry {
  const template = {
    id: "slow-pane",
    paneId: "slow",
    label: "Slow",
    description: "Slow",
    shortcut: { prefix: "SLOW", argPlaceholder: "", argKind: "text" as const },
    headless: { shape: "rows" as const, argument: { kind: "none" as const }, options: [], load },
  };
  return {
    panes: new Map([["slow", { id: "slow", name: "Slow", component: () => null, defaultPosition: "right" as const }]]),
    paneTemplates: new Map([[template.id, template]]),
  } as unknown as PluginRegistry;
}

const config = createDefaultConfig("/tmp/gloom-view-loader");
const spec = normalizeViewSpec({ source: { pane: "SLOW" }, projection: {} });

test("a source that has not answered in time opens with a note instead of failing", async () => {
  const never = registryWith(() => new Promise(() => {}));
  const warnings = await trialLoadViewSource(spec, config, { registry: never, timeoutMs: 20 });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("had not answered");
});

test("a source that loads no rows says so, and one that fails throws its own error", async () => {
  const empty = registryWith(async () => ({ rows: [] }));
  expect(await trialLoadViewSource(spec, config, { registry: empty })).toEqual(["The source loaded no rows."]);
  const failing = registryWith(async () => { throw new Error("Feed unavailable."); });
  await expect(trialLoadViewSource(spec, config, { registry: failing })).rejects.toThrow("Feed unavailable.");
});
