import type {
  DesktopBackendRequestArgs,
  DesktopBackendRequestMethod,
  DesktopBackendRequestPayload,
  DesktopBackendRequestResponse,
  DesktopRestartMessage,
  ElectrobunBackendInit,
} from "../../shared/protocol";

export function backendRequest<T = unknown>(
  method: "capability.invoke",
  payload: DesktopBackendRequestPayload<"capability.invoke">,
): Promise<T>;
export function backendRequest<K extends Exclude<DesktopBackendRequestMethod, "capability.invoke">>(
  method: K,
  ...args: DesktopBackendRequestArgs<K>
): Promise<DesktopBackendRequestResponse<K>>;
export async function backendRequest(_method: string, _payload?: unknown): Promise<unknown> {
  throw new Error("Electrobun backend requests are unavailable in the CLI screenshot renderer.");
}

export async function initElectrobunBackend(): Promise<ElectrobunBackendInit> {
  throw new Error("Electrobun backend initialization is unavailable in the CLI screenshot renderer.");
}

export function requestElectrobunRestart(_message: DesktopRestartMessage = {}): void {}

export function getElectrobunBackendInitSnapshot(): ElectrobunBackendInit | null {
  return null;
}

export function onBackendMessage(..._args: unknown[]): () => void {
  return () => {};
}
