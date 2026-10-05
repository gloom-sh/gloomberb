import { useShellPaneManagementShortcuts } from "../components/layout/shell/pane/management-shortcuts";

type ShellPaneKeyOptions = Parameters<typeof useShellPaneManagementShortcuts>[0];

/**
 * The shell's pane keys (window modes, share, pop out, double-Esc close)
 * beside a pane under test. Every action declines unless the test passes its
 * own. Rendered after the pane, its handlers register after the pane's, the
 * order a pane restored with the layout at launch has in the app.
 */
export function TestShellPaneKeys(options: Partial<ShellPaneKeyOptions> & { focusedPaneId: string }) {
  const none = () => false;
  useShellPaneManagementShortcuts({
    cancelActiveDrag: () => {},
    closeAllFloatingPanes: none,
    closeFocusedPane: none,
    copyFocusedPaneScreenshot: none,
    exportFocusedPaneCsv: none,
    gridlockVisiblePanes: none,
    hasActiveDrag: none,
    inputCaptured: false,
    openFocusedPaneMenu: none,
    openFocusedPaneSettings: none,
    openLayoutGallery: () => {},
    overlayOpen: false,
    popOutFocusedPane: none,
    shareFocusedPane: none,
    startWindowMode: () => {},
    toggleFocusedPaneFullscreen: none,
    toggleFocusedPaneFloating: none,
    ...options,
  });
  return null;
}
