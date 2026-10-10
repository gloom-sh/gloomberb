import { getGloomberbDirs } from "../../data/config/home";
import { existsSync, mkdirSync } from "fs";
import { App } from "../../app";
import { getDataDir, initDataDir, loadConfig, setConfigStoreHost } from "../../data/config/store";
import { applyLanguageFromConfig } from "../../i18n";
import * as nodeConfigStoreHost from "../../data/config/store/node";
import type { LoadedExternalPlugin } from "../../plugins/loader";
import { pluginAutoUpdateEnabled } from "../../plugins/auto-update";
import { startNodePluginAutoUpdates } from "../../plugins/auto-update-node";
import { activateUpdatedPlugins } from "../../plugins/builtin/plugin-marketplace/activation";
import { getMarketplaceHost, setPluginManager } from "../../plugins/builtin/plugin-marketplace/store";
import { createNodePluginManager } from "../../plugins/manager-node";
import { setCurrentPluginTarget } from "../../plugins/current-target";
import { getLoadablePlugins } from "../../plugins/catalog";
import { OpenTuiInputHostProvider } from "./input-host";
import { debugLog } from "../../utils/debug-log";
import { UiHostProvider } from "../../ui/host";
import { createOpenTuiHost } from "./host";
import { openTuiUiHost } from "./ui-host";
import { OpenTuiDialogHostProvider } from "./dialog-host";
import { openTuiToastHost } from "./toast-host";
import { ToastHostProvider } from "../../ui/toast";
import { measurePerfAsync } from "../../utils/perf-marks";
import type { CliLaunchRequest } from "../../types/plugin";
import type { RemoteControlAdapter } from "../../remote/app-host";
import { startRemoteControlServer, type RemoteControlServer } from "../../remote/server";
import { createAppServices } from "../../core/app-services";
import { flushPendingPersistence } from "../../state/persist-scheduler";
import { loadOfficialPluginIds } from "../../plugins/builtin/plugin-marketplace/feed";
import { flushCrashReports, installCrashReporter } from "../../telemetry/crash-reports";
import {
  CRASH_REPORT_EXIT_FLUSH_MS,
  createNodeCrashReporterHost,
  describeNodeOs,
  installProcessCrashListeners,
  readOrCreateInstallId,
} from "../../telemetry/crash-reports-node";
import { currentTelemetryConfig } from "../../telemetry/live-config";
import { flushUsageCounts, installUsageCounter, usageCountsEnabled } from "../../telemetry/usage-counts";
import { attentionCountsEnabled, installAttentionCounter } from "../../telemetry/attention-counts";
import { starPromptEnvironmentAllows } from "../../app/star-prompt/model";
import { allowStarPrompt } from "../../app/star-prompt/runtime";

// Declared here rather than sniffed: the desktop view and the hosted browser
// app are both browser contexts but differ in what plugins may do.
setCurrentPluginTarget("tui");

/** The CLI entry restores and loads external plugins and dispatches commands before it starts the app. */
export interface StartOpenTuiAppOptions {
  externalPlugins: LoadedExternalPlugin[];
  cliLaunchRequest: CliLaunchRequest | null;
}

export async function startOpenTuiApp({ externalPlugins, cliLaunchRequest }: StartOpenTuiAppOptions): Promise<void> {
  setConfigStoreHost(nodeConfigStoreHost);
  debugLog.interceptConsole();

  const appLog = debugLog.createLogger("app");
  appLog.info("Gloomberb starting");
  const remoteControlAdapter: RemoteControlAdapter = {
    startServer: ({ dataDir, handle }) => {
      let closed = false;
      const serverPromise: Promise<RemoteControlServer> = startRemoteControlServer({
        dataDir,
        appKind: "tui",
        handle,
      });
      void serverPromise.then((server) => {
        if (closed) {
          void server.close();
          return;
        }
        appLog.info("Remote control endpoint started", {
          appKind: server.endpoint.appKind,
          port: server.endpoint.port,
        });
      }).catch((error) => {
        appLog.error("Remote control endpoint failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return () => {
        closed = true;
        void serverPromise.then((server) => server.close()).catch(() => {});
      };
    },
  };

  const pluginManager = createNodePluginManager("tui");
  setPluginManager(pluginManager);

  let host: Awaited<ReturnType<typeof createOpenTuiHost>> | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  const finishProcessExit = () => {
    if (exitTimer) return;
    exitTimer = setTimeout(() => {
      void Promise.allSettled([
        flushPendingPersistence(),
        flushCrashReports({ timeoutMs: CRASH_REPORT_EXIT_FLUSH_MS }),
        flushUsageCounts({ timeoutMs: CRASH_REPORT_EXIT_FLUSH_MS }),
      ]).finally(() => process.exit(process.exitCode ?? 0));
    }, 0);
  };
  try {
    const dataDir = await getDataDir() ?? getGloomberbDirs().data;

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const config = await measurePerfAsync("startup.opentui.init-data-dir", () => initDataDir(dataDir));
    applyLanguageFromConfig(config);
    installCrashReporter(createNodeCrashReporterHost({
      surface: "terminal",
      getConfig: () => ({ dataDir: config.dataDir, telemetry: currentTelemetryConfig(config)?.telemetry }),
    }));
    installUsageCounter({
      surface: "terminal",
      os: describeNodeOs(),
      isEnabled: () => usageCountsEnabled(currentTelemetryConfig(config), process.env),
      getInstallId: () => readOrCreateInstallId(config.dataDir),
      officialPluginIds: loadOfficialPluginIds,
    });
    const stopAttention = installAttentionCounter(() => attentionCountsEnabled(currentTelemetryConfig(config), process.env));
    allowStarPrompt(starPromptEnvironmentAllows({
      env: process.env,
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
    }));
    host = await measurePerfAsync("startup.opentui.create-host", () => createOpenTuiHost());
    const renderer = host.renderer;
    renderer.once("destroy", stopAttention);
    // The renderer already listens for uncaught errors and keeps the process
    // running; these listeners live exactly as long as it does, so nothing
    // changes about when the process exits.
    renderer.once("destroy", installProcessCrashListeners());
    renderer.once("destroy", finishProcessExit);

    host.render(
      <UiHostProvider ui={openTuiUiHost} renderer={host.rendererHost} nativeRenderer={host.nativeRenderer}>
        <OpenTuiInputHostProvider>
          <ToastHostProvider host={openTuiToastHost}>
            <OpenTuiDialogHostProvider>
              <App
                config={config}
                servicesFactory={createAppServices}
                externalPlugins={externalPlugins}
                plugins={getLoadablePlugins(externalPlugins)}
                cliLaunchRequest={cliLaunchRequest}
                remoteControlAdapter={remoteControlAdapter}
              />
            </OpenTuiDialogHostProvider>
          </ToastHostProvider>
        </OpenTuiInputHostProvider>
      </UiHostProvider>,
    );

    // After render: the first pass waits well past startup, and git and bun
    // run without blocking the event loop.
    const stopPluginAutoUpdates = startNodePluginAutoUpdates({
      manager: pluginManager,
      // Read from disk each pass: the setting can change while the app runs.
      isEnabled: async () => pluginAutoUpdateEnabled(await loadConfig(config.dataDir)),
      onUpdated: async (directories) => {
        const marketplace = getMarketplaceHost();
        if (marketplace) await activateUpdatedPlugins(directories, marketplace, pluginManager);
      },
    });
    renderer.once("destroy", stopPluginAutoUpdates);
  } catch (error) {
    if (exitTimer) clearTimeout(exitTimer);
    host?.renderer.off("destroy", finishProcessExit);
    host?.destroy();
    throw error;
  }
}
