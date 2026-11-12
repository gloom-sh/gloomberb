import { apiClient } from "../../../../api-client";
import type { RemoteControlHandler } from "../../../../remote/app-host";
import type { AppState } from "../../../../state/app/context";
import type { AppConfig } from "../../../../types/config";
import { getCurrentPluginTarget } from "../../../current-target";
import { ASKGSessionController, type ASKGControllerManifest } from "./controller";
import { createASKGRendererToolExecutor, loadASKGClientManifest } from "./host";
import { attachedPaneContext, type ASKGAttachedPane } from "./pane-attachment";
import { ASKGUndoManager } from "./undo";
import { buildASKGUserData } from "./user-data";

const CLIENT_VERSION = "1";

function clientKind(): "tui" | "desktop" | "web" {
  const target = getCurrentPluginTarget();
  return target === "web" || target === "desktop" ? target : "tui";
}

/** What the pane that is mounted now gives the session; the pane writes it on every render. */
export interface ASKGPaneBindings {
  config: AppConfig;
  remoteHandler: RemoteControlHandler | null;
  getAppState: () => AppState;
  /** The ticker open beside the pane and the pane's own id, read when a question is sent. */
  context: { symbol: string | null; paneId: string };
}

/**
 * The conversation an Ask Gloom pane is in: the transcript on screen and the
 * answer still coming in. It belongs to the pane, not to one drawing of it, so
 * docking, floating or stacking the pane picks it up where it was instead of
 * mounting an empty conversation and fetching the last one back.
 */
export interface ASKGPaneSession {
  controller: ASKGSessionController;
  bindings: ASKGPaneBindings;
  /** The pane the conversation on screen is about, read whenever a question goes. */
  attached: { current: ASKGAttachedPane | null };
  /** Whether this pane has already looked for the conversation it showed before. */
  restored: boolean;
}

export function createASKGPaneSession(initial: ASKGPaneBindings): ASKGPaneSession {
  const bindings = { ...initial };
  const attached: ASKGPaneSession["attached"] = { current: null };
  // Each call and each undo gets a fresh executor, so the tokens live here:
  // an executor's own manager would forget them as soon as its call returned.
  const undoManager = new ASKGUndoManager((request) => {
    const handler = bindings.remoteHandler;
    if (!handler) return Promise.reject(new Error("This window cannot undo tool calls."));
    return handler(request);
  });
  const controller = new ASKGSessionController({
    transport: apiClient.askg,
    loadManifest: () => loadASKGClientManifest(),
    getExecutor: (manifest: ASKGControllerManifest) => {
      const handler = bindings.remoteHandler;
      if (!handler) return null;
      return createASKGRendererToolExecutor({
        config: bindings.config,
        remoteHandler: handler,
        manifest: {
          tools: manifest.tools,
          manifestHash: manifest.manifestHash,
          skipped: [],
        },
        undoManager,
      });
    },
    client: { kind: clientKind(), version: CLIENT_VERSION },
    getContext: () => {
      const state = bindings.getAppState();
      const userData = buildASKGUserData({
        config: state.config,
        brokerAccounts: state.brokerAccounts,
        tickers: state.tickers.values(),
      });
      const pane = attached.current;
      // An attached pane is what the question is about: its function, its
      // symbol and, once that may go, what it shows.
      if (pane) return { ...attachedPaneContext(pane), ...(userData ? { userData } : {}) };
      return {
        ...(bindings.context.symbol ? { symbol: bindings.context.symbol } : {}),
        paneId: bindings.context.paneId,
        ...(userData ? { userData } : {}),
      };
    },
  });
  return { controller, bindings, attached, restored: false };
}

export function disposeASKGPaneSession(session: ASKGPaneSession): void {
  session.controller.dispose();
}
