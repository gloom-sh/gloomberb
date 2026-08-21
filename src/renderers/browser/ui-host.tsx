/** @jsxImportSource react */
import type { RendererHost, UiHost } from "../../ui/host";
import { safeExternalUrl } from "../../utils/external-url";
import { createDomUiHost } from "../electrobun/view/dom-ui-host";

export const browserUiHost: UiHost = createDomUiHost("browser", {
  nativePaneChrome: true,
  titleBarOverlay: true,
  nativeWindowChrome: false,
  nativeContextMenu: false,
  publicSharing: true,
});

export const browserRendererHost: RendererHost = {
  supportsNativeDesktopNotifications: false,
  requestExit() {},
  notify() {},
  async openExternal(rawUrl) {
    const url = safeExternalUrl(rawUrl);
    if (!url) return;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  },
  async copyText(text) {
    await navigator.clipboard.writeText(text);
  },
  async readText() {
    return navigator.clipboard.readText();
  },
  async copyPngImage(pngBase64) {
    const ClipboardItemCtor = globalThis.ClipboardItem;
    if (!ClipboardItemCtor || !navigator.clipboard.write) {
      throw new Error("Image clipboard is unavailable in this browser.");
    }
    const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
    await navigator.clipboard.write([
      new ClipboardItemCtor({ "image/png": new Blob([bytes], { type: "image/png" }) }),
    ]);
  },
};
