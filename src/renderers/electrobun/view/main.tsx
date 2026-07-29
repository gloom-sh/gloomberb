/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { App } from "../../../app";
import { applyLanguageFromConfig } from "../../../i18n";
import { UiHostProvider } from "../../../ui/host";
import { debugLog } from "../../../utils/debug-log";
import { measurePerfAsync } from "../../../utils/perf-marks";
import {
  backendRequest,
  initElectrobunBackend,
  setElectrobunRemoteRequestHandler,
} from "./backend-rpc";
import { installElectrobunAiHost } from "./ai-host";
import { installElectrobunBrokerRemoteClient } from "./broker-remote-client";
import { installElectrobunConfigStoreHost } from "./config-host";
import { WebDialogHostProvider } from "./dialog-host";
import {
  installElectrobunCloudApiFetchTransport,
  installElectrobunHttpFetchTransport,
} from "./http-fetch";
import { installElectrobunUpdateHost } from "./update-host";
import { DesktopFatalScreen, ElectrobunErrorBoundary } from "./fatal-screen";
import { WebInputHostProvider } from "./input-host";
import { webNativeRenderer } from "./native-renderer";
import { WebToastHostProvider } from "./toast-host";
import { createWebUiHost, webRendererHost } from "./ui-host";
import { createApplicationMenuBridge } from "./application-menu-bridge";
import { createDesktopDeepLinkBridge } from "./desktop-deeplink-bridge";
import { createDesktopWindowBridge } from "./desktop/window/bridge";
import { prepareDetachedSnapshot } from "./desktop/window/snapshot";
import { createElectrobunAppServices } from "./app-services";

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
  installElectrobunAiHost();
  const desktopSnapshot = init.windowKind === "detached" && init.paneId && init.desktopSnapshot
    ? prepareDetachedSnapshot(init.desktopSnapshot, init.paneId)
    : init.desktopSnapshot;
  const config = desktopSnapshot?.config ?? init.config;
  applyLanguageFromConfig(config);
  const desktopWindowBridge = createDesktopWindowBridge(init.windowKind, init.paneId);
  const desktopApplicationMenuBridge = createApplicationMenuBridge();
  const desktopDeepLinkBridge = createDesktopDeepLinkBridge();
  const webUiHost = createWebUiHost(init.desktopPlatform);
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
