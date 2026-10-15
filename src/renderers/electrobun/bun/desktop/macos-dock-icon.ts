import { appIconColors, appIconSvg } from "./app-icon";
import { getTheme } from "../../../../theme/themes";
import { objcOrNull, type Objc, type ObjcId } from "./macos-objc";

let appliedThemeId: string | null = null;

function createImage(objc: Objc, svg: string): ObjcId | null {
  const bytes = Buffer.from(svg);
  const data = objc.sendBytes(
    objc.send(objc.getClass("NSData"), objc.selector("alloc")),
    objc.selector("initWithBytes:length:"),
    bytes,
    bytes.byteLength,
  );
  if (!data) return null;
  const image = objc.sendObject(
    objc.send(objc.getClass("NSImage"), objc.selector("alloc")),
    objc.selector("initWithData:"),
    data,
  );
  objc.sendVoid(data, objc.selector("release"));
  return image;
}

/**
 * Repaints the Dock icon in the active theme's accent. The bundle icon stays
 * the official mint one, so the Dock shows it again whenever Gloomberb quits.
 */
export function applyMacosDockIcon(themeId: string): void {
  if (themeId === appliedThemeId) return;
  const objc = objcOrNull();
  if (!objc) return;
  appliedThemeId = themeId;

  try {
    // Older macOS versions cannot read SVG images; they keep the bundle icon.
    const image = createImage(objc, appIconSvg(appIconColors(getTheme(themeId))));
    if (!image) return;
    const app = objc.send(objc.getClass("NSApplication"), objc.selector("sharedApplication"));
    // AppKit only takes this on the main thread, and Bun runs on another one.
    objc.sendOnMainThread(
      app,
      objc.selector("performSelectorOnMainThread:withObject:waitUntilDone:"),
      objc.selector("setApplicationIconImage:"),
      image,
      false,
    );
    objc.sendVoid(image, objc.selector("release"));
  } catch (error) {
    console.error("[dock-icon] failed to apply the theme icon", error);
  }
}
