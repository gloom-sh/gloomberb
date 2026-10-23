/**
 * Where the main window's page finds the launch frame (dom/boot-frame.ts):
 * the Bun process sets it in the window's preload, before the page's own
 * scripts run. A window it is not set in, one holding a popped-out pane,
 * draws no frame.
 */
export const DESKTOP_BOOT_FRAME_GLOBAL = "__gloomDesktopBootFrame";
