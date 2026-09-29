/** @jsxImportSource react */
import { setCurrentPluginTarget } from "../../plugins/current-target";
import "../electrobun/view/styles.css";
import { createRoot } from "react-dom/client";
import { App } from "../../app";
import { loadConfig } from "../../data/config/store";
import { applyLanguageFromConfig } from "../../i18n";
import { getBrowserPlugins } from "../../plugins/catalog-browser";
import { DomErrorBoundary, DomHostProviders } from "../electrobun/view/dom-host-providers";
import { installFocusScopeRelease } from "../electrobun/view/host/focus-scope";
import { installDomMarketDataFrames } from "../electrobun/view/data-frames";
import { createBrowserAppServices } from "./app-services";
import {
  installBrowserFetchTransports,
  restoreBrowserCloudSession,
} from "./cloud-transport";
import { loadWebBundledPlugins } from "./bundled-plugins";
import { BROWSER_DATA_DIR, hasSavedBrowserConfig, installBrowserConfigStore } from "./config-host";
import { browserRendererHost, browserUiHost } from "./ui-host";
import { createBrowserDeepLinkBridge } from "./deeplink-bridge";
import { initializeBrowserResearchActivity, recordResearchActivity } from "../../api-client/research-activity";
import { flushPendingPersistence } from "../../state/persist-scheduler";
import { loadOfficialPluginIds } from "../../plugins/builtin/plugin-marketplace/feed";
import { crashReportsEnabled, installCrashReporter, reportCrash } from "../../telemetry/crash-reports";
import {
  browserDoNotTrack,
  describeBrowserOs,
  installWindowCrashListeners,
  readOrCreateBrowserInstallId,
} from "../../telemetry/crash-reports-dom";
import { currentTelemetryConfig } from "../../telemetry/live-config";
import { installUsageCounter, recordRestoredFunctions, usageCountsEnabled } from "../../telemetry/usage-counts";
import { installWindowUsageFlush } from "../../telemetry/usage-counts-dom";
import type { AppConfig } from "../../types/config";

// Declared here rather than sniffed: the desktop view and the hosted browser
// app are both browser contexts but differ in what plugins may do.
setCurrentPluginTarget("web");
installWindowCrashListeners();
installWindowUsageFlush();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing root element");
const appRootElement = rootElement;
appRootElement.tabIndex = -1;
const root = createRoot(appRootElement);
root.render(<div className="gloom-loading">Starting Gloomberb...</div>);

async function boot(): Promise<void> {
  installBrowserConfigStore();
  let loadedConfig: AppConfig | null = null;
  installCrashReporter({
    surface: "web",
    os: describeBrowserOs(),
    isEnabled: () => !browserDoNotTrack() && crashReportsEnabled(currentTelemetryConfig(loadedConfig)),
    getInstallId: () => readOrCreateBrowserInstallId(),
  });
  installUsageCounter({
    surface: "web",
    os: describeBrowserOs(),
    isEnabled: () => !browserDoNotTrack() && usageCountsEnabled(currentTelemetryConfig(loadedConfig)),
    getInstallId: () => readOrCreateBrowserInstallId(),
    officialPluginIds: loadOfficialPluginIds,
  });
  // A document reload does not unmount React. Flush both config and session
  // timers while localStorage is still available, including background tabs.
  window.addEventListener("pagehide", () => { void flushPendingPersistence(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushPendingPersistence();
  });
  installBrowserFetchTransports();
  initializeBrowserResearchActivity();
  installFocusScopeRelease();
  installDomMarketDataFrames();
  // Started before the session restore so the plugin modules download while
  // that request is in flight, and awaited before the first render so their
  // panes are registered by the time a saved layout asks for one. A failure
  // here must not stop the app: the built-in catalog is enough to run on, and
  // the marketplace reports what broke.
  const bundledPlugins = loadWebBundledPlugins().catch(() => []);
  await restoreBrowserCloudSession();
  recordResearchActivity("workspace_opened");
  // Nothing was restored on a first visit, only the starter workspace shown.
  if (!hasSavedBrowserConfig()) recordRestoredFunctions([]);
  const config = await loadConfig(BROWSER_DATA_DIR);
  loadedConfig = config;
  applyLanguageFromConfig(config);
  const externalPlugins = await bundledPlugins;
  const deepLinkBridge = createBrowserDeepLinkBridge();
  root.render(
    <DomErrorBoundary label="Browser renderer crashed" fallback={(error) => (
      <div className="gloom-fatal">
        <h1>Gloomberb crashed</h1>
        <pre>{error instanceof Error ? error.message : String(error)}</pre>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    )}>
      <DomHostProviders ui={browserUiHost} renderer={browserRendererHost}>
        <App
          config={config}
          servicesFactory={createBrowserAppServices}
          externalPlugins={externalPlugins}
          plugins={getBrowserPlugins(externalPlugins)}
          desktopDeepLinkBridge={deepLinkBridge}
          updatesEnabled={false}
        />
      </DomHostProviders>
    </DomErrorBoundary>,
  );
  appRootElement.focus({ preventScroll: true });
}

void boot().catch((error) => {
  reportCrash(error, { kind: "uncaught" });
  const message = error instanceof Error ? error.message : String(error);
  root.render(<div className="gloom-fatal"><h1>Gloomberb failed to start</h1><pre>{message}</pre></div>);
});
