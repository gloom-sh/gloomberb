import { Electroview } from "electrobun/view";
import {
  type ApplicationMenuSelectMessage,
  type CapabilityEventMessage,
  type ContextMenuSelectMessage,
  type DesktopDeepLinkMessage,
  type DesktopBackendRequestArgs,
  type DesktopBackendRequestMethod,
  type DesktopBackendRequestPayload,
  type DesktopBackendRequestResponse,
  type DesktopDockPreviewMessage,
  type DesktopRestartMessage,
  type DesktopStateMessage,
  type DesktopThemePreviewMessage,
  type ElectrobunBackendInit,
  type RemoteControlRequestMessage,
  type ElectrobunDesktopRpcSchema,
  type UpdateProgressMessage,
} from "../shared/protocol";
import { decodeRpcValue, encodeRpcValue } from "./rpc-codec";
import type { RemoteControlRequest, RemoteControlResponse } from "../../../remote/types";

type ContextMenuSelectListener = (message: ContextMenuSelectMessage) => void;
type ApplicationMenuSelectListener = (message: ApplicationMenuSelectMessage) => void;
type DesktopDeepLinkListener = (message: DesktopDeepLinkMessage) => void;
type DesktopStateListener = (message: DesktopStateMessage) => void;
type DesktopDockPreviewListener = (message: DesktopDockPreviewMessage) => void;
type DesktopThemePreviewListener = (message: DesktopThemePreviewMessage) => void;
type UpdateProgressListener = (message: UpdateProgressMessage) => void;
type CapabilityEventListener = (message: CapabilityEventMessage) => void;
type RemoteControlRequestHandler = (request: RemoteControlRequest) => Promise<RemoteControlResponse>;

let initSnapshot: ElectrobunBackendInit | null = null;
let remoteControlRequestHandler: RemoteControlRequestHandler | null = null;
const contextMenuSelectListeners = new Map<string, Set<ContextMenuSelectListener>>();
const applicationMenuSelectListeners = new Set<ApplicationMenuSelectListener>();
const desktopDeepLinkListeners = new Set<DesktopDeepLinkListener>();
const pendingDesktopDeepLinks: DesktopDeepLinkMessage[] = [];
const desktopStateListeners = new Set<DesktopStateListener>();
const desktopDockPreviewListeners = new Set<DesktopDockPreviewListener>();
const desktopThemePreviewListeners = new Set<DesktopThemePreviewListener>();
const updateProgressListeners = new Set<UpdateProgressListener>();
const capabilityEventListeners = new Map<string, Set<CapabilityEventListener>>();

function dispatch<T>(
  listeners: Map<string, Set<(value: T) => void>>,
  key: string,
  value: T,
): void {
  for (const listener of listeners.get(key) ?? []) {
    listener(value);
  }
}

function subscribe<T>(
  listeners: Map<string, Set<(value: T) => void>>,
  key: string,
  listener: (value: T) => void,
): () => void {
  if (!listeners.has(key)) {
    listeners.set(key, new Set());
  }
  listeners.get(key)!.add(listener);
  return () => {
    const bucket = listeners.get(key);
    if (!bucket) return;
    bucket.delete(listener);
    if (bucket.size === 0) {
      listeners.delete(key);
    }
  };
}

function dispatchDesktopDeepLink(message: DesktopDeepLinkMessage): void {
  if (desktopDeepLinkListeners.size === 0) {
    pendingDesktopDeepLinks.push(message);
    if (pendingDesktopDeepLinks.length > 20) pendingDesktopDeepLinks.shift();
    return;
  }
  for (const listener of desktopDeepLinkListeners) {
    listener(message);
  }
}

const rpc = Electroview.defineRPC<ElectrobunDesktopRpcSchema>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      "remote.request": async (message: RemoteControlRequestMessage) => {
        if (!remoteControlRequestHandler) {
          return {
            ok: false,
            error: {
              code: "remote_unavailable",
              message: "The desktop app has not installed a remote control handler yet.",
            },
          };
        }
        const decoded = decodeRpcValue<RemoteControlRequest>(message.request);
        return encodeRpcValue(await remoteControlRequestHandler(decoded)) as RemoteControlResponse;
      },
    },
    messages: {
      "context-menu.select": (message) => {
        dispatch(contextMenuSelectListeners, message.requestId, message);
      },
      "application-menu.select": (message) => {
        const decoded = { command: decodeRpcValue<ApplicationMenuSelectMessage["command"]>(message.command) };
        for (const listener of applicationMenuSelectListeners) {
          listener(decoded);
        }
      },
      "desktop.deepLink": (message) => {
        if (typeof message.url !== "string" || !message.url) return;
        dispatchDesktopDeepLink({ url: message.url });
      },
      "desktop.state": (message) => {
        for (const listener of desktopStateListeners) {
          listener({ snapshot: decodeRpcValue(message.snapshot) });
        }
      },
      "desktop.dockPreview": (message) => {
        for (const listener of desktopDockPreviewListeners) {
          listener({ preview: decodeRpcValue(message.preview) });
        }
      },
      "desktop.themePreview": (message) => {
        for (const listener of desktopThemePreviewListeners) {
          listener({ preview: decodeRpcValue(message.preview) });
        }
      },
      "update.progress": (message) => {
        const decoded = { progress: decodeRpcValue<UpdateProgressMessage["progress"]>(message.progress) };
        for (const listener of updateProgressListeners) {
          listener(decoded);
        }
      },
      "capability.event": (message) => {
        dispatch(capabilityEventListeners, message.subscriptionId, {
          subscriptionId: message.subscriptionId,
          event: decodeRpcValue(message.event),
        });
      },
    },
  },
});

const electroview = new Electroview({ rpc });

async function waitForBridgeReady(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    if (electroview.bunSocket?.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Electrobun RPC socket did not open in time.");
}

export function backendRequest<T = unknown>(
  method: "capability.invoke",
  payload: DesktopBackendRequestPayload<"capability.invoke">,
): Promise<T>;
export function backendRequest<K extends Exclude<DesktopBackendRequestMethod, "capability.invoke">>(
  method: K,
  ...args: DesktopBackendRequestArgs<K>
): Promise<DesktopBackendRequestResponse<K>>;
export async function backendRequest(
  method: DesktopBackendRequestMethod,
  payload: unknown = null,
): Promise<unknown> {
  await waitForBridgeReady();
  const result = await rpc.request["backend.request"]({
    method,
    payload: encodeRpcValue(payload),
  });
  return decodeRpcValue(result);
}

export async function initElectrobunBackend(payload?: { kind?: "main" | "detached"; paneId?: string }): Promise<ElectrobunBackendInit> {
  initSnapshot = await backendRequest("init", payload ?? {});
  return initSnapshot;
}

export function requestElectrobunRestart(message: DesktopRestartMessage = {}): void {
  rpc.send["host.restart"](message);
}

export function getElectrobunBackendInitSnapshot(): ElectrobunBackendInit | null {
  return initSnapshot;
}

export function setElectrobunRemoteRequestHandler(handler: RemoteControlRequestHandler | null): () => void {
  remoteControlRequestHandler = handler;
  return () => {
    if (remoteControlRequestHandler === handler) {
      remoteControlRequestHandler = null;
    }
  };
}

export function onCapabilityEvent(
  subscriptionId: string,
  listener: (message: CapabilityEventMessage) => void,
): () => void {
  return subscribe(capabilityEventListeners, subscriptionId, listener);
}

export function onContextMenuSelect(
  requestId: string,
  listener: (message: ContextMenuSelectMessage) => void,
): () => void {
  return subscribe(contextMenuSelectListeners, requestId, listener);
}

export function onApplicationMenuSelect(listener: ApplicationMenuSelectListener): () => void {
  applicationMenuSelectListeners.add(listener);
  return () => {
    applicationMenuSelectListeners.delete(listener);
  };
}

export function onDesktopDeepLink(listener: DesktopDeepLinkListener): () => void {
  desktopDeepLinkListeners.add(listener);
  for (const message of pendingDesktopDeepLinks.splice(0)) {
    listener(message);
  }
  return () => {
    desktopDeepLinkListeners.delete(listener);
  };
}

export function onDesktopState(listener: DesktopStateListener): () => void {
  desktopStateListeners.add(listener);
  return () => {
    desktopStateListeners.delete(listener);
  };
}

export function onDesktopDockPreview(listener: DesktopDockPreviewListener): () => void {
  desktopDockPreviewListeners.add(listener);
  return () => {
    desktopDockPreviewListeners.delete(listener);
  };
}

export function onDesktopThemePreview(listener: DesktopThemePreviewListener): () => void {
  desktopThemePreviewListeners.add(listener);
  return () => {
    desktopThemePreviewListeners.delete(listener);
  };
}

export function onUpdateProgress(listener: UpdateProgressListener): () => void {
  updateProgressListeners.add(listener);
  return () => {
    updateProgressListeners.delete(listener);
  };
}
