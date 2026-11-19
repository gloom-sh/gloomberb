import { existsSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";
import { heapStats } from "bun:jsc";
import { installWarmStartNetwork, warmStartNetworkFromEnv } from "./network";
import { isOwnPageSocket, secretRoute } from "./local-guard";

/**
 *   WARM_DESKTOP_APP=<checkout> WARM_DESKTOP_VIEW=<built view> WARM_DESKTOP_PORT=<port>
 *   WARM_DESKTOP_SECRET=<64 hex> GLOOMBERB_HOME=<profile> bun scripts/warm-start/desktop-backend.ts
 *
 * The desktop's Bun process for the warm-start benchmark, without windows:
 * the services the app's Bun process starts (the same SQLite cache, plugin
 * state and session in the profile), answering the view's requests with the
 * app's own handlers for data, HTTP, plugin state and cached resources. The
 * view (built with desktop-electroview.ts for `electrobun/view`) is served
 * from the same port; window, menu, update and workspace requests are
 * answered with nothing, as a single main window that never moves needs.
 * Probe reports from the page are appended to `WARM_START_PROBE_OUT`.
 *
 * Everything, the page, its socket and the heap and request counts, is served
 * under the launch's secret folder (`/<secret>/`), to requests that name the
 * server as 127.0.0.1:<port> and come from no other page (local-guard.ts).
 */
const app = process.env.WARM_DESKTOP_APP!;
const viewDir = process.env.WARM_DESKTOP_VIEW!;
const port = Number(process.env.WARM_DESKTOP_PORT);
const secret = process.env.WARM_DESKTOP_SECRET ?? "";
if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("WARM_DESKTOP_SECRET must be the launch's 64-character secret.");
const counts = { kept: 0, fetched: 0, refused: 0, streamed: 0 };
const network = warmStartNetworkFromEnv();
if (network) installWarmStartNetwork({ ...network, log: (event) => { counts[event] += 1; } });

const load = <T>(path: string): Promise<T> => import(join(app, path)) as Promise<T>;
const { getDataDir, initDataDir, saveConfig } = await load<typeof import("../../src/data/config/store")>("src/data/config/store/index.ts");
const { getGloomberbDirs } = await load<typeof import("../../src/data/config/home")>("src/data/config/home.ts");
const { createAppServices } = await load<typeof import("../../src/core/app-services")>("src/core/app-services.ts");
const { loadDesktopBackendPlugins } = await load<typeof import("../../src/plugins/catalog-backend")>("src/plugins/catalog-backend.ts");
const { registerElectrobunCoreCapabilities } = await load<typeof import("../../src/renderers/electrobun/bun/core-capabilities")>("src/renderers/electrobun/bun/core-capabilities.ts");
const { DesktopCapabilityBridge } = await load<typeof import("../../src/renderers/electrobun/bun/desktop/capability-bridge")>("src/renderers/electrobun/bun/desktop/capability-bridge.ts");
const { DesktopHttpStreamBridge } = await load<typeof import("../../src/renderers/electrobun/bun/desktop/http-stream")>("src/renderers/electrobun/bun/desktop/http-stream.ts");
const { handleHttpFetch } = await load<typeof import("../../src/renderers/electrobun/bun/desktop/http-fetch")>("src/renderers/electrobun/bun/desktop/http-fetch.ts");
const { handleDesktopPluginStateRequest, loadDesktopPluginState } = await load<typeof import("../../src/renderers/electrobun/bun/desktop/plugin-state")>("src/renderers/electrobun/bun/desktop/plugin-state.ts");
const { decodeRpcValue, encodeRpcResponse } = await load<typeof import("../../src/renderers/electrobun/shared/rpc-codec")>("src/renderers/electrobun/shared/rpc-codec.ts");
const { APP_SESSION_ID, APP_SESSION_SCHEMA_VERSION } = await load<typeof import("../../src/core/state/session-persistence")>("src/core/state/session-persistence.ts");
const brokers = await load<typeof import("../../src/brokers/account-cache")>("src/brokers/account-cache.ts");
/**
 * The desktop's handling of the view's cached resources, where the checkout
 * has it apart from the Electrobun modules; an older checkout kept broker
 * account snapshots only, which this falls back to.
 */
const viewResourcesPath = join(app, "src/renderers/electrobun/bun/desktop/view-resources.ts");
const viewResources = existsSync(viewResourcesPath)
  ? await import(viewResourcesPath) as {
    loadDesktopViewResources(services: unknown, config: unknown): unknown[];
    handleDesktopViewResourceRequest(services: unknown, request: { method: string; payload: unknown }): unknown;
  }
  : null;

const config = await initDataDir(await getDataDir() ?? getGloomberbDirs().data);
const { paneOwners: _owners, ...backendPlugins } = await loadDesktopBackendPlugins();
const services = createAppServices({ config, ...backendPlugins });
await services.ready;
registerElectrobunCoreCapabilities({ getConfig: () => config, getServices: () => services } as never);

type Socket = import("bun").ServerWebSocket<unknown>;
let view: Socket | null = null;
const rpc = {
  send: new Proxy({}, {
    get: (_target, name: string) => (payload: unknown) => view?.send(JSON.stringify({ type: "message", name, payload })),
  }),
} as never;
const capabilities = new DesktopCapabilityBridge({ getRegistry: () => services.pluginRegistry.capabilities, getWindowKey: () => "main" });
const streams = new DesktopHttpStreamBridge({ getWindowKey: () => "main" });

function init() {
  const session = services.persistence.sessions.get(APP_SESSION_ID, APP_SESSION_SCHEMA_VERSION)?.value ?? null;
  const savedResources = viewResources
    ? viewResources.loadDesktopViewResources(services, config)
    : brokers.listPersistedBrokerAccountRecords(services.persistence.resources, config.brokerInstances);
  return {
    config,
    sessionSnapshot: session,
    desktopSnapshot: null,
    desktopThemePreview: null,
    pluginState: loadDesktopPluginState(services.pluginRegistry),
    savedResources,
    capabilityManifests: services.pluginRegistry.capabilities.manifests({ rendererOnly: true, includeDisabled: true }),
    desktopPlatform: process.platform,
    hostName: hostname(),
    windowKind: "main",
    windowId: "main",
    windows: [],
    otherWindowTabs: [],
    telemetry: { installId: "warm-start-benchmark", os: process.platform, homeDir: homedir(), optedOut: true },
    viewIds: {},
  };
}

async function handle(method: string, payload: any): Promise<unknown> {
  switch (method) {
    case "init": return init();
    case "plugins.listExternal": return [];
    case "http.fetch": return handleHttpFetch(payload);
    case "http.stream.open":
    case "http.stream.cancel": return streams.handle(rpc, { method, payload } as never);
    case "capability.invoke":
    case "capability.cancel":
    case "capability.subscribe":
    case "capability.unsubscribe": return capabilities.handle(rpc, { method, payload } as never);
    case "pluginState.setMany":
    case "pluginState.delete": return handleDesktopPluginStateRequest(services.persistence.pluginState, { method, payload } as never);
    case "session.set": services.persistence.sessions.set(payload.sessionId, payload.value, payload.schemaVersion); return null;
    case "session.delete": services.persistence.sessions.delete(payload.sessionId); return null;
    case "config.save": await saveConfig({ ...payload.config, dataDir: config.dataDir }); return null;
    case "ticker.loadAll": return services.tickerRepository.loadAllTickers();
    case "ticker.load": return services.tickerRepository.loadTicker(payload.symbol);
    case "ticker.save": await services.tickerRepository.saveTicker(payload.ticker); return null;
    case "ticker.delete": await services.tickerRepository.deleteTicker(payload.symbol); return null;
    case "ticker.changesElsewhere": return null;
    case "ticker.takeDeletedElsewhere": return [];
    default:
      if (method.startsWith("resources.")) {
        if (viewResources) return viewResources.handleDesktopViewResourceRequest(services, { method, payload });
        if (method === "resources.set") brokers.saveBrokerAccountRecord(services.persistence.resources, payload.record);
        if (method === "resources.delete") brokers.deleteBrokerAccountRecord(services.persistence.resources, payload.key);
        return null;
      }
      // Windows, menus, updates, the workspace and the host's own services: nothing to do for one window that stays put.
      return null;
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request, bun) {
    const path = secretRoute(request, bun.port, secret);
    if (path === null) return new Response("Forbidden", { status: 403 });
    if (path === "/__desktop-rpc") {
      if (!isOwnPageSocket(request, bun.port)) return new Response("Forbidden", { status: 403 });
      return bun.upgrade(request, { data: undefined }) ? undefined as unknown as Response : new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    if (path === "/__warm-requests") return Response.json(counts);
    if (path === "/health") return Response.json({ status: "ok" });
    if (path === "/__warm-heap") {
      Bun.gc(true);
      return new Response(String(heapStats().heapSize));
    }
    if (path === "/__warm-heap-snapshot") return new Response(Bun.generateHeapSnapshot("v8", "arraybuffer"));
    const file = Bun.file(join(viewDir, path === "/" ? "index.html" : path.slice(1)));
    if (!path.includes("..") && await file.exists()) return new Response(file, { headers: { "cache-control": "no-cache" } });
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(socket) { view = socket; },
    async message(socket, raw) {
      const message = JSON.parse(String(raw)) as { type: string; id: number; name: string; params: { method: string; payload: unknown } };
      if (message.type !== "request" || message.name !== "backend.request") return;
      const { method, payload } = message.params;
      try {
        const result = await encodeRpcResponse(() => handle(method, decodeRpcValue(payload ?? null)));
        socket.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        socket.send(JSON.stringify({ id: message.id, error: error instanceof Error ? error.message : String(error) }));
      }
    },
    close(socket) { if (view === socket) view = null; },
  },
});

const stop = () => {
  server.stop(true);
  capabilities.disposeAll();
  streams.disposeAll();
  services.destroy();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(`ready ${server.port}`);
