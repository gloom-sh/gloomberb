import { useEffect, useMemo } from "react";
import type { Dispatch, ReactNode } from "react";
import type { PluginRegistry } from "../plugins/registry";
import type { AppAction, AppState } from "../state/app/context";
import type { DesktopWindowBridge } from "../types/desktop-window";
import { createAppRemoteController } from "./controller";
import { useRemoteUiRegistry } from "./semantic-tree";
import type { RemoteControlRequest, RemoteControlResponse } from "./types";

export type RemoteControlHandler = (request: RemoteControlRequest) => Promise<RemoteControlResponse>;

export interface RemoteControlAdapter {
  startServer?(options: { dataDir: string; handle: RemoteControlHandler }): void | (() => void | Promise<void>);
  registerHandler?(handler: RemoteControlHandler | null): void | (() => void);
}

interface RemoteControlHostProps {
  adapter?: RemoteControlAdapter;
  children: ReactNode;
  dispatch: Dispatch<AppAction>;
  getState: () => AppState;
  pluginRegistry: PluginRegistry;
  desktopWindowBridge?: DesktopWindowBridge;
}

export function RemoteControlHost({
  adapter,
  children,
  dispatch,
  getState,
  pluginRegistry,
  desktopWindowBridge,
}: RemoteControlHostProps) {
  const uiRegistry = useRemoteUiRegistry();
  const controller = useMemo(() => createAppRemoteController({
    dispatch,
    getState,
    pluginRegistry,
    uiRegistry,
    desktopWindowBridge,
    afterMutation: async () => {
      await Promise.resolve();
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(undefined);
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(finish);
        }
        setTimeout(finish, 50);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  }), [desktopWindowBridge, dispatch, getState, pluginRegistry, uiRegistry]);
  const dataDir = getState().config.dataDir;

  useEffect(() => {
    if (!adapter?.startServer) return;
    const cleanup = adapter.startServer({ dataDir, handle: controller.handle });
    if (!cleanup) return;
    return () => {
      void cleanup();
    };
  }, [adapter, controller, dataDir]);

  useEffect(() => {
    if (!adapter?.registerHandler) return;
    const cleanup = adapter.registerHandler(controller.handle);
    if (!cleanup) return;
    return () => {
      cleanup();
    };
  }, [adapter, controller]);

  return children;
}
