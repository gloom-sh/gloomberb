import { useAppSelector } from "../../state/app/context";
import { useUiCapabilities } from "../../ui";

/**
 * Which app chrome is on screen. Presentation mode (`presentationMode` in the
 * config) leaves the window to the panes: no header (the command prompt and
 * the market summary) and no status bar (layout tabs, version, account and
 * feedback). The header comes back while the command bar is open, as its
 * prompt is where the command bar types, and stays in the desktop app, where
 * it is the window's own title bar with its window controls.
 */
export function useAppChromeShown(): { header: boolean; statusBar: boolean } {
  const { titleBarOverlay = false, nativeWindowChrome = true } = useUiCapabilities();
  const windowTitleBar = titleBarOverlay && nativeWindowChrome;
  const presentation = useAppSelector((state) => state.config.presentationMode === true);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const statusBarVisible = useAppSelector((state) => state.statusBarVisible);
  return {
    header: !presentation || commandBarOpen || windowTitleBar,
    statusBar: statusBarVisible && !presentation,
  };
}
