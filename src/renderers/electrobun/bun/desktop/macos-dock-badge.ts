import { cString, objcOrNull } from "./macos-objc";

/**
 * Sets the red badge on the Dock icon (`NSDockTile.badgeLabel`, public AppKit
 * API); an empty label removes it. Electrobun has no Dock badge call, so this
 * reaches AppKit the way the theme Dock icon does. macOS only; a no-op
 * anywhere else, and when the Objective-C runtime cannot be loaded.
 */
export function setMacosDockBadge(label: string): void {
  const objc = objcOrNull();
  if (!objc) return;

  try {
    const app = objc.send(objc.getClass("NSApplication"), objc.selector("sharedApplication"));
    const dockTile = objc.send(app, objc.selector("dockTile"));
    if (!dockTile) return;
    const text = label
      ? objc.sendObject(
        objc.send(objc.getClass("NSString"), objc.selector("alloc")),
        objc.selector("initWithUTF8String:"),
        cString(label),
      )
      : null;
    // AppKit only takes this on the main thread, and Bun runs on another one.
    // The call retains the string until it has run; a null label is nil.
    objc.sendOnMainThread(
      dockTile,
      objc.selector("performSelectorOnMainThread:withObject:waitUntilDone:"),
      objc.selector("setBadgeLabel:"),
      text,
      false,
    );
    if (text) objc.sendVoid(text, objc.selector("release"));
  } catch (error) {
    console.error("[dock-badge] failed to set the Dock badge", error);
  }
}
