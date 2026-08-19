import { NOTES_FILES_CAPABILITY_ID } from "../../../../capabilities";
import type {
  ApplicationMenuSelectMessage,
  CapabilityEventMessage,
  ContextMenuSelectMessage,
  DesktopBackendRequestArgs,
  DesktopBackendRequestMethod,
  DesktopBackendRequestPayload,
  DesktopBackendRequestResponse,
  DesktopDockPreviewMessage,
  DesktopRestartMessage,
  DesktopStateMessage,
  DesktopThemePreviewMessage,
  ElectrobunBackendInit,
  UpdateProgressMessage,
} from "../../shared/protocol";

type Listener<T> = (message: T) => void;

function unsubscribe(): () => void {
  return () => {};
}

export function backendRequest<T = unknown>(
  method: "capability.invoke",
  payload: DesktopBackendRequestPayload<"capability.invoke">,
): Promise<T>;
export function backendRequest<K extends Exclude<DesktopBackendRequestMethod, "capability.invoke">>(
  method: K,
  ...args: DesktopBackendRequestArgs<K>
): Promise<DesktopBackendRequestResponse<K>>;
export async function backendRequest(method: string, payload?: unknown): Promise<unknown> {
  const neutral = neutralReadResult(method, payload);
  if (neutral !== undefined) return neutral;
  throw new Error("Electrobun backend requests are unavailable in the CLI screenshot renderer.");
}

/**
 * There is no backend behind a screenshot, so a read that only feeds the view
 * degrades to an empty result and the pane renders its real empty state instead
 * of the whole render dying on one rejected request. Writes keep throwing: a
 * pane must never believe it saved something that went nowhere.
 */
function neutralReadResult(method: string, payload: unknown): unknown {
  if (method !== "capability.invoke") return undefined;
  const request = payload as { capabilityId?: string; operationId?: string } | undefined;
  if (request?.capabilityId !== NOTES_FILES_CAPABILITY_ID) return undefined;
  if (request.operationId === "load") return "";
  if (request.operationId === "loadQuickNotesIndex") return [];
  return undefined;
}

export async function initElectrobunBackend(): Promise<ElectrobunBackendInit> {
  throw new Error("Electrobun backend initialization is unavailable in the CLI screenshot renderer.");
}

export function requestElectrobunRestart(_message: DesktopRestartMessage = {}): void {}

export function getElectrobunBackendInitSnapshot(): ElectrobunBackendInit | null {
  return null;
}

export function onCapabilityEvent(_subscriptionId: string, _listener: Listener<CapabilityEventMessage>): () => void {
  return unsubscribe();
}

export function onContextMenuSelect(_requestId: string, _listener: Listener<ContextMenuSelectMessage>): () => void {
  return unsubscribe();
}

export function onApplicationMenuSelect(_listener: Listener<ApplicationMenuSelectMessage>): () => void {
  return unsubscribe();
}

export function onDesktopState(_listener: Listener<DesktopStateMessage>): () => void {
  return unsubscribe();
}

export function onDesktopDockPreview(_listener: Listener<DesktopDockPreviewMessage>): () => void {
  return unsubscribe();
}

export function onDesktopThemePreview(_listener: Listener<DesktopThemePreviewMessage>): () => void {
  return unsubscribe();
}

export function onUpdateProgress(_listener: Listener<UpdateProgressMessage>): () => void {
  return unsubscribe();
}
