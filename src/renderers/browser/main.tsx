/** @jsxImportSource react */
import "../electrobun/view/styles.css";
import { createRoot } from "react-dom/client";
import { App } from "../../app";
import { loadConfig } from "../../data/config/store";
import { applyLanguageFromConfig } from "../../i18n";
import { getBrowserBuiltinPlugins } from "../../plugins/catalog-browser";
import { UiHostProvider } from "../../ui/host";
import { WebDialogHostProvider } from "../electrobun/view/dialog-host";
import { BrowserErrorBoundary } from "./error-boundary";
import { installFocusScopeRelease } from "../electrobun/view/host/focus-scope";
import { WebInputHostProvider } from "../electrobun/view/input-host";
import { webNativeRenderer } from "../electrobun/view/native-renderer";
import { WebToastHostProvider } from "../electrobun/view/toast-host";
import { createBrowserAppServices } from "./app-services";
import {
  installBrowserFetchTransports,
  restoreBrowserCloudSession,
} from "./cloud-transport";
import { BROWSER_DATA_DIR, installBrowserConfigStore } from "./config-host";
import { browserRendererHost, browserUiHost } from "./ui-host";
import { createBrowserDeepLinkBridge } from "./deeplink-bridge";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing root element");
const appRootElement = rootElement;
appRootElement.tabIndex = -1;
const root = createRoot(appRootElement);
root.render(<div className="gloom-loading">Starting Gloomberb...</div>);

async function boot(): Promise<void> {
  installBrowserConfigStore();
  installBrowserFetchTransports();
  installFocusScopeRelease();
  await restoreBrowserCloudSession();
  const config = await loadConfig(BROWSER_DATA_DIR);
  applyLanguageFromConfig(config);
  const deepLinkBridge = createBrowserDeepLinkBridge();
  root.render(
    <BrowserErrorBoundary>
      <UiHostProvider ui={browserUiHost} renderer={browserRendererHost} nativeRenderer={webNativeRenderer}>
        <WebInputHostProvider>
          <WebToastHostProvider>
            <WebDialogHostProvider>
              <App
                config={config}
                servicesFactory={createBrowserAppServices}
                plugins={getBrowserBuiltinPlugins()}
                desktopDeepLinkBridge={deepLinkBridge}
                updatesEnabled={false}
              />
            </WebDialogHostProvider>
          </WebToastHostProvider>
        </WebInputHostProvider>
      </UiHostProvider>
    </BrowserErrorBoundary>,
  );
  appRootElement.focus({ preventScroll: true });
}

void boot().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  root.render(<div className="gloom-fatal"><h1>Gloomberb failed to start</h1><pre>{message}</pre></div>);
});
