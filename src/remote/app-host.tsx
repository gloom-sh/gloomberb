import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { Dispatch, ReactNode } from "react";
import type { PluginRegistry } from "../plugins/registry";
import type { AppAction, AppState } from "../state/app/context";
import type { DesktopWindowBridge } from "../types/desktop-window";
import { useOptionalDialog } from "../ui/dialog";
import { confirmRemoteChange } from "./confirm-change";
import { createAppRemoteController } from "./controller";
import { useRemoteUiRegistry } from "./semantic-tree";
import type { RemoteCallContext, RemoteControlRequest, RemoteControlResponse } from "./types";

/** `context` is for callers inside this process; the local endpoint sends requests alone. */
export type RemoteControlHandler = (request: RemoteControlRequest, context?: RemoteCallContext) => Promise<RemoteControlResponse>;

const RemoteControlHandlerContext = createContext<RemoteControlHandler | null>(null);

/**
 * The in-process handler for app operations and resources, or null outside a
 * remote control host. Panes use it to run the same operations a remote client
 * would, instead of opening a second controller.
 */
export function useRemoteControlHandler(): RemoteControlHandler | null {
  return useContext(RemoteControlHandlerContext);
}

export interface RemoteControlAdapter {
  startServer?(options: { dataDir: string; handle: RemoteControlHandler }): void | (() => void | Promise<void>);
  registerHandler?(handler: RemoteControlHandler | null): void | (() => void);
  /**
   * Set where a remote assistant may drive this app through Gloom Cloud: what
   * kind of app it is and the machine name it shows under.
   */
  terminalDevice?: { kind: "desktop" | "tui"; name: string };
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
  // Read at call time, so a new dialog host never restarts the server.
  const dialog = useOptionalDialog();
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const controller = useMemo(() => createAppRemoteController({
    dispatch,
    getState,
    pluginRegistry,
    uiRegistry,
    desktopWindowBridge,
    confirmChange: async (prompt, signal) => {
      const host = dialogRef.current;
      if (!host) throw new Error("This window cannot ask for confirmation, so nothing changed.");
      return confirmRemoteChange(host, prompt, signal);
    },
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

  return (
    <RemoteControlHandlerContext value={controller.handle}>
      {children}
    </RemoteControlHandlerContext>
  );
}
