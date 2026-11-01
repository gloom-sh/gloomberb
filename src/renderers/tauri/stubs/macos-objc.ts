// The Bun sidecar has no NSApplication: the shell owns the Dock.
export type Objc = never;
export type ObjcId = bigint;
export const cString = (value: string) => Buffer.from(`${value}\0`);
export function objcOrNull(): null {
  return null;
}
