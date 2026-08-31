import type { AppSessionSnapshot } from "../../../core/state/session-persistence";
import type { PaneRuntimeState } from "../../../core/state/app/state";
import type { DesktopDockPreviewState, DesktopSharedStateSnapshot, DesktopThemePreviewState } from "../../../types/desktop-window";
import type { DesktopApplicationMenuCommand } from "../../../types/desktop-menu";
import type { AppConfig } from "../../../types/config";
import type { LiveStreamResolveRequest, ResolvedLiveStream } from "../../../types/media";
import type { TickerRecord } from "../../../types/ticker";
import type { ReleaseInfo, UpdateCheckResult, UpdateProgress } from "../../../updater";
import type { CapabilityManifest } from "../../../capabilities";
import type { RemoteControlRequest, RemoteControlResponse } from "../../../remote/types";

export const ELECTROBUN_CONTEXT_MENU_ACTION = "gloom.context-menu.select";

export interface ElectrobunBackendInit {
  config: AppConfig;
  sessionSnapshot: AppSessionSnapshot | null;
  desktopSnapshot: DesktopSharedStateSnapshot | null;
  desktopThemePreview: DesktopThemePreviewState;
  pluginState: Record<string, Record<string, unknown>>;
  capabilityManifests: CapabilityManifest[];
  desktopPlatform: string;
  windowKind: "main" | "detached";
  paneId?: string;
}

export interface DesktopRestartMessage {
  reason?: string;
  source?: string;
}

export type DesktopWindowControlAction = "minimize" | "toggle-maximize" | "close";

export type DesktopContextMenuItem =
  | { type: "divider" }
  | {
    type?: "normal";
    label?: string;
    tooltip?: string;
    action?: string;
    role?: string;
    data?: unknown;
    submenu?: DesktopContextMenuItem[];
    enabled?: boolean;
    checked?: boolean;
    hidden?: boolean;
    accelerator?: string;
  };

export interface DesktopPluginStateSetEntry {
  pluginId: string;
  key: string;
  value: unknown;
  schemaVersion?: number;
}

export interface DesktopHttpFetchRequest {
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: "follow" | "error" | "manual";
    timeoutMs?: number;
  };
}

export interface DesktopHttpFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookie?: string[];
  body: string;
}

export interface DesktopCapabilityInvokeRequest {
  capabilityId: string;
  operationId: string;
  payload?: unknown;
  invocationId?: string;
}

export interface DesktopCapabilitySubscribeRequest extends DesktopCapabilityInvokeRequest {
  subscriptionId: string;
}

/**
 * One external plugin, compiled for the view.
 *
 * The Bun process owns the filesystem, so it reads and bundles the plugin and
 * hands the view executable module text. `error` is carried rather than thrown
 * so a single broken plugin surfaces in the marketplace instead of taking down
 * the renderer.
 */
export interface DesktopExternalPluginBundle {
  id: string;
  name: string;
  version: string;
  path: string;
  /** ES module source, absent when `error` is set. */
  code?: string;
  targets?: readonly ("cli" | "tui" | "desktop" | "web")[];
  error?: string;
}

export interface DesktopBackendRequestMap {
  init: {
    request: { kind?: "main" | "detached"; paneId?: string };
    response: ElectrobunBackendInit;
  };
  "http.fetch": { request: DesktopHttpFetchRequest; response: DesktopHttpFetchResponse };
  "media.resolveLiveStream": { request: LiveStreamResolveRequest; response: ResolvedLiveStream };
  "remote.forward": { request: { request: RemoteControlRequest }; response: RemoteControlResponse };
  "capability.invoke": { request: DesktopCapabilityInvokeRequest; response: unknown };
  "capability.cancel": { request: { invocationId: string }; response: null };
  "capability.subscribe": { request: DesktopCapabilitySubscribeRequest; response: null };
  "capability.unsubscribe": { request: { subscriptionId: string }; response: null };
  "desktop.syncMainState": { request: { snapshot: DesktopSharedStateSnapshot }; response: null };
  "desktop.setThemePreview": { request: { preview: DesktopThemePreviewState }; response: null };
  "desktop.replaceDetachedPaneState": {
    request: { paneId: string; paneState: PaneRuntimeState };
    response: null;
  };
  "desktop.popOutPane": { request: { paneId: string }; response: null };
  "desktop.dockDetachedPane": {
    request: { paneId: string; edge?: "left" | "right" | "top" | "bottom" };
    response: null;
  };
  "desktop.closeDetachedPane": { request: { paneId: string }; response: null };
  "desktop.focusDetachedPane": { request: { paneId: string }; response: null };
  "pluginState.set": { request: DesktopPluginStateSetEntry; response: null };
  "pluginState.setMany": { request: { entries: DesktopPluginStateSetEntry[] }; response: null };
  "pluginState.delete": { request: { pluginId: string; key: string }; response: null };
  "plugins.listExternal": { request: null; response: DesktopExternalPluginBundle[] };
  "host.restart": { request: DesktopRestartMessage; response: null };
  "host.exit": { request: null; response: null };
  "host.windowControl": { request: { action: DesktopWindowControlAction }; response: null };
  "host.openExternal": { request: { url: string }; response: null };
  "host.copyText": { request: { text: string }; response: null };
  "host.focusWindow": { request: null; response: null };
  "host.copyPngImage": { request: { pngBase64: string }; response: null };
  "host.readText": { request: null; response: string };
  "host.saveTextFile": {
    request: { name: string; text: string; mimeType: string };
    response: string;
  };
  "host.notify": {
    request: { title?: string; body?: string; subtitle?: string; sound?: string };
    response: null;
  };
  "host.showContextMenu": { request: { menu: DesktopContextMenuItem[] }; response: boolean };
  "update.check": { request: { currentVersion: string }; response: UpdateCheckResult };
  "update.start": { request: { release: ReleaseInfo; currentVersion?: string }; response: null };
  "ticker.loadAll": { request: null; response: TickerRecord[] };
  "ticker.load": { request: { symbol: string }; response: TickerRecord | null };
  "ticker.save": { request: { ticker: TickerRecord }; response: null };
  "ticker.delete": { request: { symbol: string }; response: null };
  "config.save": { request: { config: AppConfig }; response: null };
  "config.resetAllData": { request: { dataDir: string }; response: null };
  "config.export": { request: { config: AppConfig; destPath: string }; response: null };
  "config.import": { request: { dataDir: string; srcPath: string }; response: AppConfig };
  "session.set": {
    request: { sessionId: string; value: unknown; schemaVersion?: number };
    response: null;
  };
  "session.delete": { request: { sessionId: string }; response: null };
}

export type DesktopBackendRequestMethod = keyof DesktopBackendRequestMap;
export type DesktopBackendRequestPayload<K extends DesktopBackendRequestMethod> =
  DesktopBackendRequestMap[K]["request"];
export type DesktopBackendRequestResponse<K extends DesktopBackendRequestMethod> =
  DesktopBackendRequestMap[K]["response"];
export type DesktopBackendRequestFor<K extends DesktopBackendRequestMethod> = {
  [Method in K]: {
    method: Method;
    payload: DesktopBackendRequestPayload<Method>;
  };
}[K];
export type DesktopBackendRequest = DesktopBackendRequestFor<DesktopBackendRequestMethod>;
export type DesktopBackendRequestArgs<K extends DesktopBackendRequestMethod> =
  null extends DesktopBackendRequestPayload<K>
    ? [payload?: DesktopBackendRequestPayload<K>]
    : [payload: DesktopBackendRequestPayload<K>];

export type DesktopCapabilityRequest = DesktopBackendRequestFor<Extract<DesktopBackendRequestMethod, `capability.${string}`>>;
export type DesktopWorkspaceRequest = DesktopBackendRequestFor<Extract<DesktopBackendRequestMethod, `desktop.${string}`>>;
export type DesktopPluginStateRequest = DesktopBackendRequestFor<Extract<DesktopBackendRequestMethod, `pluginState.${string}`>>;
export type DesktopHostRequest = DesktopBackendRequestFor<Extract<DesktopBackendRequestMethod, `host.${string}`>>;
export type DesktopCoreRequest = DesktopBackendRequestFor<
  Extract<DesktopBackendRequestMethod, `update.${string}` | `ticker.${string}` | `config.${string}` | `session.${string}`>
>;

interface BackendRequestPayload {
  method: DesktopBackendRequestMethod;
  payload?: unknown;
}

export interface ContextMenuSelectMessage {
  requestId: string;
  itemId: string;
}

export interface ApplicationMenuSelectMessage {
  command: DesktopApplicationMenuCommand;
}

export interface DesktopStateMessage {
  snapshot: DesktopSharedStateSnapshot;
}

export interface DesktopDockPreviewMessage {
  preview: DesktopDockPreviewState;
}

export interface DesktopThemePreviewMessage {
  preview: DesktopThemePreviewState;
}

export interface UpdateProgressMessage {
  progress: UpdateProgress;
}

export interface CapabilityEventMessage {
  subscriptionId: string;
  event: unknown;
}

export interface DesktopDeepLinkMessage {
  url: string;
}

export interface RemoteControlRequestMessage {
  request: RemoteControlRequest;
}

export interface ElectrobunDesktopRpcSchema {
  bun: {
    requests: {
      "backend.request": {
        params: BackendRequestPayload;
        response: unknown;
      };
    };
    messages: {
      "host.restart": DesktopRestartMessage;
    };
  };
  webview: {
    requests: {
      "remote.request": {
        params: RemoteControlRequestMessage;
        response: RemoteControlResponse;
      };
    };
    messages: {
      "context-menu.select": ContextMenuSelectMessage;
      "application-menu.select": ApplicationMenuSelectMessage;
      "desktop.state": DesktopStateMessage;
      "desktop.dockPreview": DesktopDockPreviewMessage;
      "desktop.themePreview": DesktopThemePreviewMessage;
      "desktop.deepLink": DesktopDeepLinkMessage;
      "update.progress": UpdateProgressMessage;
      "capability.event": CapabilityEventMessage;
    };
  };
}
