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
