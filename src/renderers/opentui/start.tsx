import { getGloomberbHome } from "../../data/config/home";
import { existsSync, mkdirSync } from "fs";
import { App } from "../../app";
import { dispatchCli } from "../../cli/index";
import { getDataDir, initDataDir, setConfigStoreHost } from "../../data/config/store";
import { applyLanguageFromConfig } from "../../i18n";
import * as nodeConfigStoreHost from "../../data/config/store/node";
import { loadExternalPlugins } from "../../plugins/loader";
import { restoreExtractedPlugins } from "../../cli/restore-plugins";
import { setPluginManager } from "../../plugins/builtin/plugin-marketplace/store";
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
import { colors } from "../../theme/colors";
import { measurePerfAsync } from "../../utils/perf-marks";
import type { CliLaunchRequest } from "../../types/plugin";
import type { RemoteControlAdapter } from "../../remote/app-host";
import { startRemoteControlServer, type RemoteControlServer } from "../../remote/server";
import { createAppServices } from "../../core/app-services";
import { flushPendingPersistence } from "../../state/persist-scheduler";

// Declared here rather than sniffed: the desktop view and the hosted browser
// app are both browser contexts but differ in what plugins may do.
setCurrentPluginTarget("tui");

export interface StartOpenTuiAppOptions {
  externalPlugins?: Awaited<ReturnType<typeof loadExternalPlugins>>;
  cliArgs?: string[];
  skipCliDispatch?: boolean;
  cliLaunchRequest?: CliLaunchRequest | null;
}

export async function startOpenTuiApp(options: StartOpenTuiAppOptions = {}): Promise<void> {
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

  const cliArgs = options.cliArgs ?? process.argv.slice(2);
  // Before the catalog is read, so a plugin that moved out of this repository is
  // available in the same session rather than only after a restart. Placed here
  // rather than in the CLI entry because `src/index.tsx` starts the app directly
  // and would otherwise skip it.
  if (!options.externalPlugins) {
    await measurePerfAsync("startup.opentui.restore-plugins", restoreExtractedPlugins);
  }

  setPluginManager(createNodePluginManager("tui"));

  const externalPlugins = options.externalPlugins ?? await measurePerfAsync("startup.opentui.load-external-plugins", () => loadExternalPlugins("tui"));
  let cliLaunchRequest = options.cliLaunchRequest ?? null;
  if (!options.skipCliDispatch && cliArgs.length > 0) {
    const dispatchResult = await dispatchCli(cliArgs, { externalPlugins });
    if (dispatchResult.kind === "handled") return;
    if (dispatchResult.kind === "launch-ui") {
      cliLaunchRequest = dispatchResult.request;
    }
  }

  let host: Awaited<ReturnType<typeof createOpenTuiHost>> | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  const finishProcessExit = () => {
    if (exitTimer) return;
    exitTimer = setTimeout(() => {
      void flushPendingPersistence().finally(() => process.exit(process.exitCode ?? 0));
    }, 0);
  };
  try {
    const dataDir = await getDataDir() ?? getGloomberbHome();

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const config = await measurePerfAsync("startup.opentui.init-data-dir", () => initDataDir(dataDir));
    applyLanguageFromConfig(config);
    host = await measurePerfAsync("startup.opentui.create-host", () => createOpenTuiHost());
    const renderer = host.renderer;
    renderer.once("destroy", finishProcessExit);

    host.render(
      <UiHostProvider ui={openTuiUiHost} renderer={host.rendererHost} nativeRenderer={host.nativeRenderer}>
        <OpenTuiInputHostProvider>
          <ToastHostProvider host={openTuiToastHost}>
            <OpenTuiDialogHostProvider
              size="medium"
              dialogOptions={{ style: { backgroundColor: colors.bg, borderColor: colors.borderFocused, borderStyle: "single", paddingX: 2, paddingY: 1 } }}
              backdropColor={colors.bg}
              backdropOpacity={0.8}
            >
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
  } catch (error) {
    if (exitTimer) clearTimeout(exitTimer);
    host?.renderer.off("destroy", finishProcessExit);
    host?.destroy();
    throw error;
  }
}
