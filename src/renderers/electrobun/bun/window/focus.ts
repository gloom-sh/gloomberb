export const MAIN_WINDOW_RPC_KEY = "main";

const DETACHED_WINDOW_RPC_PREFIX = "detached:";

export interface FocusableElectrobunWindow {
  activate?: () => void;
  focus?: () => void;
}

export function detachedRpcKey(instanceId: string): string {
  return `${DETACHED_WINDOW_RPC_PREFIX}${instanceId}`;
}

export function paneIdFromDetachedRpcKey(rpcKey: string | undefined): string | null {
  if (!rpcKey?.startsWith(DETACHED_WINDOW_RPC_PREFIX)) return null;
  return rpcKey.slice(DETACHED_WINDOW_RPC_PREFIX.length) || null;
}

function resolveWindowForRpcKey<T>(
  rpcKey: string | undefined,
  mainWindow: T | null,
  detachedWindows: ReadonlyMap<string, T>,
): T | null {
  if (rpcKey === MAIN_WINDOW_RPC_KEY) return mainWindow;
  const paneId = paneIdFromDetachedRpcKey(rpcKey);
  return paneId ? detachedWindows.get(paneId) ?? null : null;
}

export function focusWindowForRpcKey(
  rpcKey: string | undefined,
  mainWindow: FocusableElectrobunWindow | null,
  detachedWindows: ReadonlyMap<string, FocusableElectrobunWindow>,
): boolean {
  const window = resolveWindowForRpcKey(rpcKey, mainWindow, detachedWindows);
  if (window?.activate) {
    window.activate();
    return true;
  }
  if (!window?.focus) return false;
  window.focus();
  return true;
}
