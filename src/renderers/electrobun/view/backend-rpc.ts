import { Electroview } from "electrobun/view";
import {
  type DesktopDeepLinkMessage,
  type DesktopBackendRequestArgs,
  type DesktopBackendRequestMethod,
  type DesktopBackendRequestPayload,
  type DesktopBackendRequestResponse,
  type DesktopDockPreviewMessage,
  type DesktopRestartMessage,
  type DesktopThemePreviewMessage,
  type ElectrobunBackendInit,
  type RemoteControlRequestMessage,
  type ElectrobunDesktopRpcSchema,
} from "../shared/protocol";
import { decodeRpcResponse, decodeRpcValue, encodeRpcValue } from "../shared/rpc-codec";
import { subscribeCapability, type CapabilitySubscriptionOptions } from "./capability-subscription";
import { RpcTimeoutError } from "../../../utils/rpc-timeout-error";
import { nameRpcTimeout, RPC_MAX_REQUEST_TIME_MS } from "./rpc-timeout";
import type { RemoteControlRequest, RemoteControlResponse } from "../../../remote/types";

type BackendMessages = ElectrobunDesktopRpcSchema["webview"]["messages"];
type BackendMessageName = keyof BackendMessages;
/** Messages addressed to one context menu, capability subscription or HTTP stream. */
type KeyedBackendMessageName = "context-menu.select" | "capability.event" | "http.stream.chunk";
type BackendMessageListener<K extends BackendMessageName> = (message: BackendMessages[K]) => void;
type RemoteControlRequestHandler = (request: RemoteControlRequest) => Promise<RemoteControlResponse>;

let initSnapshot: ElectrobunBackendInit | null = null;
let remoteControlRequestHandler: RemoteControlRequestHandler | null = null;
const messageListeners = new Map<string, Set<(message: unknown) => void>>();
const pendingDesktopDeepLinks: DesktopDeepLinkMessage[] = [];

function listenerKey(name: BackendMessageName, key: string | undefined): string {
  return key === undefined ? name : `${name}\u0000${key}`;
}

/** Hands a decoded message to its listeners and returns how many there were. */
function emit<K extends BackendMessageName>(name: K, message: BackendMessages[K], key?: string): number {
  const listeners = messageListeners.get(listenerKey(name, key));
  for (const listener of listeners ?? []) {
    listener(message);
  }
  return listeners?.size ?? 0;
}

const rpc = Electroview.defineRPC<ElectrobunDesktopRpcSchema>({
  maxRequestTime: RPC_MAX_REQUEST_TIME_MS,
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
        emit("context-menu.select", message, message.requestId);
      },
      "application-menu.select": (message) => {
        emit("application-menu.select", { command: decodeRpcValue(message.command) });
      },
      "desktop.deepLink": (message) => {
        if (typeof message.url !== "string" || !message.url) return;
        const deepLink = { url: message.url };
        if (emit("desktop.deepLink", deepLink) > 0) return;
        pendingDesktopDeepLinks.push(deepLink);
        if (pendingDesktopDeepLinks.length > 20) pendingDesktopDeepLinks.shift();
      },
      "desktop.state": (message) => {
        emit("desktop.state", { snapshot: decodeRpcValue(message.snapshot) });
      },
      "desktop.dockPreview": (message) => {
        emit("desktop.dockPreview", { preview: decodeRpcValue<DesktopDockPreviewMessage["preview"]>(message.preview) });
      },
      "desktop.themePreview": (message) => {
        emit("desktop.themePreview", { preview: decodeRpcValue<DesktopThemePreviewMessage["preview"]>(message.preview) });
      },
      "update.progress": (message) => {
        emit("update.progress", { progress: decodeRpcValue(message.progress) });
      },
      "plugins.updated": (message) => {
        if (!Array.isArray(message?.directories)) return;
        const directories = message.directories.filter((directory): directory is string => typeof directory === "string");
        emit("plugins.updated", { directories });
      },
      "capability.event": (message) => {
        emit("capability.event", {
          subscriptionId: message.subscriptionId,
          event: decodeRpcValue(message.event),
        }, message.subscriptionId);
      },
      "http.stream.chunk": (message) => {
        if (typeof message?.streamId !== "string") return;
        emit("http.stream.chunk", message, message.streamId);
      },
    },
  },
});

const electroview = new Electroview({ rpc });

const BRIDGE_READY_LIMIT_MS = 5_000;

async function waitForBridgeReady(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BRIDGE_READY_LIMIT_MS) {
    if (electroview.bunSocket?.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new RpcTimeoutError("Electrobun RPC socket did not open in time.", {
    elapsedMs: Date.now() - start,
    limitMs: BRIDGE_READY_LIMIT_MS,
  });
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
  const result = await nameRpcTimeout(method, payload, () => rpc.request["backend.request"]({
    method,
    payload: encodeRpcValue(payload),
  }));
  return decodeRpcResponse(result);
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

/**
 * The registry reads capability manifests from the init snapshot, which is
 * what the Bun process had at launch. A plugin activated there afterwards
 * hands back the new set, and this is how the view adopts it.
 */
export function replaceElectrobunCapabilityManifests(manifests: ElectrobunBackendInit["capabilityManifests"]): void {
  if (!initSnapshot) return;
  initSnapshot = { ...initSnapshot, capabilityManifests: manifests };
}

export function setElectrobunRemoteRequestHandler(handler: RemoteControlRequestHandler | null): () => void {
  remoteControlRequestHandler = handler;
  return () => {
    if (remoteControlRequestHandler === handler) {
      remoteControlRequestHandler = null;
    }
  };
}

/**
 * Listens for a message the Bun process sends this window. Keyed messages
 * belong to one context menu request, capability subscription or HTTP stream,
 * and only reach the listeners registered under that id. A deep link that
 * arrived before anyone listened is replayed to the first listener.
 */
export function onBackendMessage<K extends Exclude<BackendMessageName, KeyedBackendMessageName>>(
  name: K,
  listener: BackendMessageListener<K>,
): () => void;
export function onBackendMessage<K extends KeyedBackendMessageName>(
  name: K,
  key: string,
  listener: BackendMessageListener<K>,
): () => void;
export function onBackendMessage(
  name: BackendMessageName,
  keyOrListener: string | ((message: never) => void),
  keyedListener?: (message: never) => void,
): () => void {
  const key = typeof keyOrListener === "string" ? keyOrListener : undefined;
  const listener = (keyedListener ?? keyOrListener) as (message: unknown) => void;
  const bucketKey = listenerKey(name, key);
  let listeners = messageListeners.get(bucketKey);
  if (!listeners) {
    listeners = new Set();
    messageListeners.set(bucketKey, listeners);
  }
  listeners.add(listener);
  if (name === "desktop.deepLink") {
    for (const message of pendingDesktopDeepLinks.splice(0)) {
      listener(message);
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && messageListeners.get(bucketKey) === listeners) {
      messageListeners.delete(bucketKey);
    }
  };
}

export function subscribeBackendCapability(options: CapabilitySubscriptionOptions): () => void {
  return subscribeCapability({
    subscribe: (request) => backendRequest("capability.subscribe", request),
    unsubscribe: (subscriptionId) => backendRequest("capability.unsubscribe", { subscriptionId }),
    onEvent: (subscriptionId, listener) => onBackendMessage("capability.event", subscriptionId, (message) => {
      listener(message.event);
    }),
  }, options);
}
