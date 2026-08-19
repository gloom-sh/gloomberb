import type { NativeRendererHost } from "../../../../../ui";

export function getCachedKittySupport(_renderer: NativeRendererHost): boolean {
  return false;
}

export function ensureKittySupport(_renderer: NativeRendererHost): Promise<boolean> {
  return Promise.resolve(false);
}

// The desktop webview is never behind a terminal multiplexer and never draws
// kitty graphics, so both answers are constant here.
export function isMultiplexedTerminal(): boolean {
  return false;
}

export function resolveKittySupport(): boolean {
  return false;
}
