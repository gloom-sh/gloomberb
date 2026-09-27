import type { ApplicationMenuItemConfig } from "electrobun/bun";
import type { DesktopApplicationMenuCommand } from "../../../../types/desktop-menu";
import type { KeybindingsConfig } from "../../../../types/config";
import { menuAcceleratorFor } from "../../../../app/keybindings/labels";
import { resolveKeybindings, type ResolvedKeybindings } from "../../../../app/keybindings/resolve";

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

function buildApplicationMenu(keybindings: ResolvedKeybindings): ApplicationMenuItemConfig[] {
  const accelerator = (actionId: string) => ({ accelerator: menuAcceleratorFor(keybindings, actionId) });
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
        openCommandBar("Search Ticker...", "DES ", accelerator("ticker-search")),
        { type: "divider" },
        commandItem("New Portfolio...", { type: "open-builtin-workflow", actionId: "new-portfolio" }),
        commandItem("New Watchlist...", { type: "open-builtin-workflow", actionId: "new-watchlist" }),
        commandItem("Set Portfolio Position...", { type: "open-builtin-workflow", actionId: "set-portfolio-position" }),
        { type: "divider" },
        commandItem("Add Broker Account...", { type: "open-builtin-workflow", actionId: "add-broker-account" }),
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
        openCommandBar("Open Command Bar", "", accelerator("command-bar")),
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
        commandItem("Layouts...", { type: "open-layout-gallery" }, accelerator("layout-gallery")),
        openCommandBar("Layout Actions...", "LMA "),
        { type: "divider" },
        commandItem("Undo Layout Change", { type: "layout-undo" }),
        commandItem("Redo Layout Change", { type: "layout-redo" }),
        commandItem("Tidy Windows", { type: "layout-gridlock" }, accelerator("tidy-windows")),
        { type: "divider" },
        commandItem("New Layout...", { type: "open-builtin-workflow", actionId: "new-layout" }),
        commandItem("Rename Current Layout...", { type: "open-builtin-workflow", actionId: "rename-layout" }),
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

export function buildDesktopApplicationMenu(
  platform = process.platform,
  keybindings?: KeybindingsConfig,
): ApplicationMenuItemConfig[] {
  return platform === "win32" ? [] : buildApplicationMenu(resolveKeybindings(keybindings));
}
