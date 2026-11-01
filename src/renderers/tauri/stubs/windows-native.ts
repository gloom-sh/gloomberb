// Electrobun's Windows window workarounds; the Tauri shell needs none of them.
export type Win32 = never;
export function fitPageToClientArea(_handle: unknown): boolean {
  return false;
}
export function startSystemWindowMove(_handle: unknown): boolean {
  return false;
}
export function wideString(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
export function withWindowHandle(_title: string, _apply: unknown): void {}
