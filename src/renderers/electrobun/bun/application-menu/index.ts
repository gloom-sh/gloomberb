import type { ApplicationMenuItemConfig } from "electrobun/bun";
import type { DesktopApplicationMenuCommand } from "../../../../types/desktop-menu";

export const ELECTROBUN_APPLICATION_MENU_ACTION = "gloom.application-menu.select";
const GITHUB_ISSUE_URL = "https://github.com/gloom-sh/gloomberb/issues/new/choose";

export type ElectrobunApplicationMenuCommand =
  | DesktopApplicationMenuCommand
  | { type: "open-devtools" }
  | { type: "quit" };

function commandItem(
  label: string,
  command: ElectrobunApplicationMenuCommand,
  options: { accelerator?: string } = {},
): ApplicationMenuItemConfig {
  return {
    label,
    action: ELECTROBUN_APPLICATION_MENU_ACTION,
    data: command,
    ...(options.accelerator ? { accelerator: options.accelerator } : {}),
  };
}

function openCommandBar(label: string, query: string, options?: { accelerator?: string }): ApplicationMenuItemConfig {
  return commandItem(label, { type: "open-command-bar", query }, options);
}

function buildApplicationMenu(): ApplicationMenuItemConfig[] {
  return [
    {
      label: "Gloomberb",
      submenu: [
        { role: "about" },
        { type: "divider" },
        commandItem("Check for Updates...", { type: "check-for-updates" }),
        { type: "divider" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "divider" },
        commandItem("Quit Gloomberb", { type: "quit" }, { accelerator: "CmdOrCtrl+Q" }),
      ],
    },
    {
      label: "File",
      submenu: [
        openCommandBar("Search Ticker...", "DES "),
        { type: "divider" },
        openCommandBar("New Portfolio...", "New Portfolio"),
        openCommandBar("New Watchlist...", "New Watchlist"),
        openCommandBar("Set Portfolio Position...", "Set Portfolio Position"),
        { type: "divider" },
        openCommandBar("Add Broker Account...", "Add Broker Account"),
        { type: "divider" },
        openCommandBar("Import Config...", "Import Config"),
        openCommandBar("Export Config...", "Export Config"),
        { type: "divider" },
        openCommandBar("Reset All Data...", "Reset All Data"),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "divider" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        openCommandBar("Open Command Bar", "", { accelerator: "CmdOrCtrl+K" }),
        commandItem("Open Developer Tools", { type: "open-devtools" }),
        { type: "divider" },
        commandItem("Toggle Status Bar", { type: "toggle-status-bar" }),
        { type: "divider" },
        openCommandBar("Change Theme...", "TH "),
        openCommandBar("Manage Plugins...", "PL "),
      ],
    },
    {
      label: "Layout",
      submenu: [
        commandItem("Layouts...", { type: "open-layout-gallery" }, { accelerator: "CmdOrCtrl+Shift+L" }),
        openCommandBar("Layout Actions...", "LMA "),
        { type: "divider" },
        commandItem("Undo Layout Change", { type: "layout-undo" }),
        commandItem("Redo Layout Change", { type: "layout-redo" }),
        commandItem("Tidy Windows", { type: "layout-gridlock" }, { accelerator: "CmdOrCtrl+Shift+G" }),
        { type: "divider" },
        commandItem("New Layout...", { type: "open-plugin-workflow", commandId: "new-layout" }),
        commandItem("Rename Current Layout...", { type: "open-plugin-workflow", commandId: "rename-layout" }),
        openCommandBar("Duplicate Current Layout", "Duplicate Layout"),
        openCommandBar("Delete Current Layout...", "Delete Layout"),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "divider" },
        { role: "toggleFullScreen" },
        { type: "divider" },
        { role: "close" },
        { type: "divider" },
        { role: "bringAllToFront" },
      ],
    },
    {
      label: "Help",
      submenu: [
        openCommandBar("Gloomberb Help", "HELP"),
        commandItem("Open Issue on GitHub", { type: "open-url", url: GITHUB_ISSUE_URL }),
      ],
    },
  ];
}

export function buildDesktopApplicationMenu(platform = process.platform): ApplicationMenuItemConfig[] {
  return platform === "win32" ? [] : buildApplicationMenu();
}
