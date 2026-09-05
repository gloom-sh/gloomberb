import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServices } from "../../../../core/app-services";
import {
  appReducer,
  createInitialState,
  type AppAction,
} from "../../../../core/state/app/state";
import { getLoadablePlugins } from "../../../catalog";
import { createAppRemoteController } from "../../../../remote/controller";
import type { RemoteUiRegistry } from "../../../../remote/semantic-tree";
import { createDefaultConfig } from "../../../../types/config";
import type { ASKGToolCallEvent, ClientToolManifest } from "./protocol";
import { createASKGToolExecutor } from "./executor";
import { buildASKGClientManifest, REMOTE_RESOURCE_TOOL_NAME } from "./manifest";

function toolCall(tool: ClientToolManifest, args: ASKGToolCallEvent["args"]): ASKGToolCallEvent {
  return {
    seq: 1,
    type: "tool-call",
    turnId: "verify-turn",
    toolCallId: `verify-${tool.name}`,
    name: tool.name,
    args,
    writeTier: tool.writeTier,
    requiresConfirmation: false,
    preview: null,
    timeoutMs: tool.timeoutMs,
    expiresAt: new Date(Date.now() + tool.timeoutMs).toISOString(),
  };
}

function resultShape(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value == null) return String(value);
  if (typeof value !== "object") return typeof value;
  return Object.keys(value as Record<string, unknown>).sort().join(",") || "object";
}

async function verify() {
  const dataDir = mkdtempSync(join(tmpdir(), "gloomberb-askg-client-"));
  const config = { ...createDefaultConfig(dataDir), onboardingComplete: true };
  const services = createAppServices({ config, plugins: getLoadablePlugins() });
  try {
    await services.ready;
    let state = createInitialState(config);
    const dispatch = (action: AppAction) => {
      state = appReducer(state, action);
    };
    services.pluginRegistry.getConfigFn = () => state.config;
    services.pluginRegistry.getLayoutFn = () => state.config.layout;
    services.pluginRegistry.updateLayoutFn = (layout) => dispatch({ type: "UPDATE_LAYOUT", layout });

    const uiRegistry: RemoteUiRegistry = {
      register() {},
      unregister() {},
      snapshot: () => [],
      invoke: async () => null,
    };
    const remote = createAppRemoteController({
      dispatch,
      getState: () => state,
      pluginRegistry: services.pluginRegistry,
      uiRegistry,
    });
    const built = await buildASKGClientManifest(services.pluginRegistry);
    const sources = { headless: 0, "remote-op": 0 };
    const tiers = { read: 0, "ui-write": 0, "user-data": 0, broker: 0 };
    for (const tool of built.tools) {
      sources[tool.source] += 1;
      tiers[tool.writeTier] += 1;
    }

    console.log(JSON.stringify({
      totalTools: built.tools.length,
      sources,
      tiers,
      headlessNames: built.tools.filter(({ source }) => source === "headless").map(({ name }) => name),
      manifestHash: built.manifestHash,
      skipped: built.skipped,
    }, null, 2));

    const executor = createASKGToolExecutor({
      manifests: built.tools,
      registry: services.pluginRegistry,
      context: {
        config,
        dataDir,
        persistence: services.persistence,
        store: services.tickerRepository,
        dataProvider: services.providerRouter,
      },
      remoteHandler: remote.handle,
    });
    const headless = built.tools.find(({ source, name, argument }) => (
      source === "headless" && name === "val" && (argument?.kind === "none" || argument?.optional)
    )) ?? built.tools.find(({ source, argument }) => (
      source === "headless" && (argument?.kind === "none" || argument?.optional)
    ));
    const resource = built.tools.find(({ name }) => name === REMOTE_RESOURCE_TOOL_NAME);
    if (!headless || !resource) throw new Error("Verification tools are missing from the manifest.");

    const headlessResult = await executor.execute(toolCall(headless, {}));
    const remoteResult = await executor.execute(toolCall(resource, { resource: "app://snapshot" }));
    console.log(JSON.stringify({
      headless: {
        name: headless.name,
        status: headlessResult.status,
        resultShape: resultShape(headlessResult.result),
        rowCount: headlessResult.rowCount,
        elapsedMs: headlessResult.elapsedMs,
      },
      remote: {
        name: resource.name,
        status: remoteResult.status,
        resultShape: resultShape(remoteResult.result),
        rowCount: remoteResult.rowCount,
        elapsedMs: remoteResult.elapsedMs,
      },
    }, null, 2));
  } finally {
    services.destroy();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await verify();
}
