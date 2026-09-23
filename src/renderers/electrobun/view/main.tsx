/** @jsxImportSource react */
import { setCurrentPluginTarget } from "../../../plugins/current-target";
import { createRoot } from "react-dom/client";
import { App } from "../../../app";
import { applyLanguageFromConfig } from "../../../i18n";
import { UiHostProvider } from "../../../ui/host";
import { debugLog } from "../../../utils/debug-log";
import { measurePerfAsync } from "../../../utils/perf-marks";
import {
  backendRequest,
  initElectrobunBackend,
  replaceElectrobunCapabilityManifests,
  setElectrobunRemoteRequestHandler,
} from "./backend-rpc";
import { installElectrobunCapabilityStreamClient } from "./capability-stream-client";
import { installFocusScopeRelease } from "./host/focus-scope";
import { installElectrobunBrokerRemoteClient } from "./broker-remote-client";
import { installElectrobunConfigStoreHost } from "./config-host";
import { WebDialogHostProvider } from "./dialog-host";
import {
  installElectrobunCloudApiFetchTransport,
  installElectrobunHttpFetchTransport,
} from "./http-fetch";
import { installElectrobunUpdateHost } from "./update-host";
import { installScreenshotWatermark } from "./screenshot-watermark";
import { installElectrobunWindowFullscreenTracking } from "./window-fullscreen";
import { installDomMarketDataFrames } from "./data-frames";
import { DesktopFatalScreen, ElectrobunErrorBoundary } from "./fatal-screen";
import { WebInputHostProvider } from "./input-host";
import { webNativeRenderer } from "./native-renderer";
import { WebToastHostProvider } from "./toast-host";
import { createWebUiHost, webRendererHost } from "./ui-host";
import { createApplicationMenuBridge } from "./application-menu-bridge";
import { createDesktopDeepLinkBridge } from "./desktop-deeplink-bridge";
import {
  initializeDesktopResearchActivity,
  observeDesktopDeepLinks,
} from "../../../api-client/research-activity";
import { createDesktopWindowBridge } from "./desktop/window/bridge";
import { prepareDetachedSnapshot } from "./desktop/window/snapshot";
import { createElectrobunAppServices } from "./app-services";
import { getRendererPlugins } from "../../../plugins/catalog-ui";
import { loadDesktopExternalPlugin, loadDesktopExternalPlugins } from "./external-plugins";
import { setPluginManager } from "../../../plugins/builtin/plugin-marketplace/store";

// Declared here rather than sniffed: the desktop view and the hosted browser
// app are both browser contexts but differ in what plugins may do.
setCurrentPluginTarget("desktop");

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element");
}
const appRootElement = rootElement;

const root = createRoot(appRootElement);
const bootLog = debugLog.createLogger("electrobun-web-boot");
let appMounted = false;

appRootElement.tabIndex = -1;
root.render(<div className="gloom-loading">Starting Gloomberb...</div>);

function renderFatalError(error: unknown, details?: string, title = "Gloomberb failed to start"): void {
  root.render(
    <DesktopFatalScreen
      title={title}
      error={error}
      details={details}
      source="renderer-fatal"
    />,
  );
}

window.__gloomRenderFatalError = (error, details, source) => {
  if (appMounted && source === "unhandledrejection") {
    return;
  }
  renderFatalError(error, details, "Gloomberb crashed");
};

function focusWebSurface(): void {
  window.focus();
  appRootElement.focus({ preventScroll: true });
}

function requestStartupFocus(): void {
  focusWebSurface();
  requestAnimationFrame(() => {
    void backendRequest("host.focusWindow")
      .catch(() => null)
      .then(() => focusWebSurface());
  });
}

async function boot() {
  bootLog.info("boot started");
  const backendInitPromise = initElectrobunBackend();
  // Avoid a premature global unhandled-rejection render while UI chunks load.
  void backendInitPromise.catch(() => {});

  installElectrobunConfigStoreHost();
  installElectrobunBrokerRemoteClient();
  installElectrobunHttpFetchTransport();
  installElectrobunCloudApiFetchTransport();
  installElectrobunUpdateHost();
  const init = await measurePerfAsync("startup.electrobun.backend-init", () => backendInitPromise);
  installElectrobunCapabilityStreamClient();
  installFocusScopeRelease();
  installElectrobunWindowFullscreenTracking();
  installDomMarketDataFrames();
  installScreenshotWatermark();
  const desktopSnapshot = init.windowKind === "detached" && init.paneId && init.desktopSnapshot
    ? prepareDetachedSnapshot(init.desktopSnapshot, init.paneId)
    : init.desktopSnapshot;
  const config = desktopSnapshot?.config ?? init.config;
  applyLanguageFromConfig(config);
  const desktopWindowBridge = createDesktopWindowBridge(init.windowKind, init.paneId);
  const desktopApplicationMenuBridge = createApplicationMenuBridge();
  initializeDesktopResearchActivity();
  const desktopDeepLinkBridge = observeDesktopDeepLinks(createDesktopDeepLinkBridge());
  const webUiHost = createWebUiHost(init.desktopPlatform);
  // Compiled by the Bun process, which owns the filesystem. A failure here must
  // not stop the app from starting: the marketplace reports broken plugins, and
  // the built-in catalog is enough to run on.
  const externalPlugins = await measurePerfAsync(
    "startup.electrobun.load-external-plugins",
    async () => {
      try {
        return await loadDesktopExternalPlugins(await backendRequest("plugins.listExternal"));
      } catch (error) {
        debugLog.createLogger("desktop-plugins").error(`External plugin load failed: ${error}`);
        return [];
      }
    },
  );

  // The view cannot run git or bun; every operation is the Bun process doing
  // it, and `load` is that process compiling the result for this renderer.
  // `activate` registers the plugin over there too, where its capabilities and
  // brokers actually run, and adopts the manifests that come back.
  setPluginManager({
    install: (repo, pin) => backendRequest("plugins.install", { ref: repo, ...(pin ? { pin } : {}) }),
    update: (directory, pin) => backendRequest("plugins.update", { directory, ...(pin ? { pin } : {}) }),
    remove: (directory) => backendRequest("plugins.remove", { directory }),
    remoteHeads: (directories) => backendRequest("plugins.remoteHeads", { directories: [...directories] }),
    load: async (directory) => {
      const bundle = await backendRequest("plugins.bundle", { directory });
      return bundle ? loadDesktopExternalPlugin(bundle) : null;
    },
    activate: async (directory) => {
      const result = await backendRequest("plugins.activate", { directory });
      if (!result.ok) return result;
      replaceElectrobunCapabilityManifests(result.capabilityManifests);
      return { ok: true };
    },
    deactivate: async (pluginId) => {
      const result = await backendRequest("plugins.deactivate", { pluginId });
      replaceElectrobunCapabilityManifests(result.capabilityManifests);
    },
  });

  const remoteControlAdapter = init.windowKind === "main"
    ? { registerHandler: setElectrobunRemoteRequestHandler }
    : undefined;
  measurePerfAsync("startup.electrobun.root-render", async () => {
    root.render(
      <ElectrobunErrorBoundary>
        <UiHostProvider ui={webUiHost} renderer={webRendererHost} nativeRenderer={webNativeRenderer}>
          <WebInputHostProvider>
            <WebToastHostProvider>
              <WebDialogHostProvider>
                <App
                  config={config}
                  servicesFactory={createElectrobunAppServices}
                  externalPlugins={externalPlugins}
                  plugins={getRendererPlugins(externalPlugins)}
                  desktopWindowBridge={desktopWindowBridge}
                  desktopApplicationMenuBridge={desktopApplicationMenuBridge}
                  desktopDeepLinkBridge={desktopDeepLinkBridge}
                  desktopSnapshot={desktopSnapshot}
                  desktopThemePreview={init.desktopThemePreview}
                  remoteControlAdapter={remoteControlAdapter}
                />
              </WebDialogHostProvider>
            </WebToastHostProvider>
          </WebInputHostProvider>
        </UiHostProvider>
      </ElectrobunErrorBoundary>,
    );
    appMounted = true;
  });
  requestStartupFocus();
  bootLog.info("root render scheduled", {
    layoutPanes: config.layout.instances.length,
    floatingPanes: config.layout.floating.length,
    detachedPanes: config.layout.detached.length,
    brokerInstances: config.brokerInstances.length,
  });
}

boot().catch((error) => {
  renderFatalError(error);
});
