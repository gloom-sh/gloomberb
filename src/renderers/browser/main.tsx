/** @jsxImportSource react */
import { setCurrentPluginTarget } from "../../plugins/current-target";
import "../dom/styles.css";
import { createRoot } from "react-dom/client";
import { App } from "../../app";
import { loadConfig } from "../../data/config/store";
import { applyLanguageFromConfig } from "../../i18n";
import { getBrowserPlugins } from "../../plugins/catalog-browser";
import { DomErrorBoundary, DomHostProviders } from "../dom/dom-host-providers";
import { installFocusScopeRelease } from "../dom/host/focus-scope";
import { installDomMarketDataFrames } from "../dom/data-frames";
import { releaseBootFrameWhenDrawn, startBootFrameRecorder } from "../dom/boot-frame";
import { BROWSER_STORAGE_KEYS } from "../../data/json-storage";
import { createBrowserAppServices } from "./app-services";
import {
  installBrowserFetchTransports,
  restoreBrowserCloudSession,
} from "./cloud-transport";
import { loadWebBundledPlugins } from "./bundled-plugins";
import {
  BROWSER_DATA_DIR,
  createBrowserFirstScreenConfig,
  hasSavedBrowserConfig,
  installBrowserConfigStore,
} from "./config-host";
import { browserRendererHost, browserUiHost } from "./ui-host";
import { createBrowserDeepLinkBridge } from "./deeplink-bridge";
import {
  exposeFirstScreen,
  FIRST_SCREEN_EXPERIMENT,
  FIRST_SCREEN_PLACEMENT,
  observeLandingLinks,
  watchFirstScreenEngagement,
} from "./first-screen";
import {
  exposeWebExperiment,
  initializeBrowserResearchActivity,
  recordResearchActivity,
} from "../../api-client/research-activity";
import { subscribeCommandBarQuery } from "../../components/command-bar/panel/prompt-binding";
import { marketplaceLayoutIdFromSearch } from "../../layout-marketplace/api";
import { paneShareIdFromSearch } from "../../shares/location";
import { flushPendingPersistence } from "../../state/persist-scheduler";
import { loadOfficialPluginIds } from "../../plugins/marketplace/feed";
import { crashReportsEnabled, installCrashReporter, reportCrash } from "../../telemetry/crash-reports";
import {
  browserDoNotTrack,
  describeBrowserOs,
  installWindowCrashListeners,
  readOrCreateBrowserInstallId,
} from "../../telemetry/crash-reports-dom";
import { currentTelemetryConfig } from "../../telemetry/live-config";
import { attentionCountsEnabled, installAttentionCounter } from "../../telemetry/attention-counts";
import {
  installUsageCounter,
  recordRestoredFunctions,
  subscribeFunctionOpens,
  usageCountsEnabled,
} from "../../telemetry/usage-counts";
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
// The page drew the last session's layout, or the bare shell, before this
// script loaded (dom/boot-frame.ts); it stays until the app has drawn its own.
const releaseBootFrame = releaseBootFrameWhenDrawn(document, appRootElement);
/** How long after the app mounts the launch frame stays at most. */
const BOOT_FRAME_RELEASE_FALLBACK_MS = 4_000;

async function boot(): Promise<void> {
  // Read before anything can save a workspace or tidy the address.
  const savedLayout = hasSavedBrowserConfig();
  const search = location.search;
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
  installAttentionCounter(() => !browserDoNotTrack() && attentionCountsEnabled(currentTelemetryConfig(loadedConfig)));
  // A document reload does not unmount React. Flush both config and session
  // timers while localStorage is still available, including background tabs.
  window.addEventListener("pagehide", () => { void flushPendingPersistence(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushPendingPersistence();
  });
  installBrowserFetchTransports();
  // Read the saved Usage switch before any research activity or attribution.
  let config = await loadConfig(BROWSER_DATA_DIR);
  loadedConfig = config;
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
  if (!savedLayout) recordRestoredFunctions([]);
  // A first visit's workspace is chosen before the dock paints, while the
  // plugins download; see first-screen.ts.
  const firstScreen = exposeFirstScreen({
    savedLayout,
    handoff: !!marketplaceLayoutIdFromSearch(search) || !!paneShareIdFromSearch(search),
    expose: (signal) => exposeWebExperiment(FIRST_SCREEN_EXPERIMENT, { placement: FIRST_SCREEN_PLACEMENT, signal }),
  });
  const [externalPlugins, screen] = await Promise.all([bundledPlugins, firstScreen]);
  if (screen === "calm") {
    config = createBrowserFirstScreenConfig(BROWSER_DATA_DIR, "calm", {
      search,
      portrait: window.innerHeight > window.innerWidth,
    });
    loadedConfig = config;
  }
  applyLanguageFromConfig(config);
  try {
    watchFirstScreenEngagement({
      counted: screen !== null,
      session: sessionStorage,
      layout: config.layout,
      record: () => recordResearchActivity("first_screen_engaged", undefined, undefined, { placement: FIRST_SCREEN_PLACEMENT }),
      sources: { subscribeFunctionOpens, subscribeCommandBarQuery },
    });
  } catch {
    /* Blocked storage: the first action is not measured. */
  }
  const deepLinkBridge = observeLandingLinks(createBrowserDeepLinkBridge());
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
  // A layout with neither panes nor a status bar has nothing to wait for.
  window.setTimeout(releaseBootFrame, BOOT_FRAME_RELEASE_FALLBACK_MS);
  startBootFrameRecorder({
    doc: document,
    root: appRootElement,
    save: (frame) => {
      try {
        localStorage.setItem(BROWSER_STORAGE_KEYS.bootFrame, JSON.stringify(frame));
      } catch {
        // Intentional ignore: storage full or blocked; the next launch draws the bare shell.
      }
    },
  });
}

void boot().catch((error) => {
  reportCrash(error, { kind: "uncaught" });
  const message = error instanceof Error ? error.message : String(error);
  releaseBootFrame();
  root.render(<div className="gloom-fatal"><h1>Gloomberb failed to start</h1><pre>{message}</pre></div>);
});
