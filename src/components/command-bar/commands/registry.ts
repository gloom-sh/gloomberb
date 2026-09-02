import type { AppAction } from "../../../state/app/context";
import type { Dispatch } from "react";

type CommandExecutor = (dispatch: Dispatch<AppAction>, context: CommandContext) => void | Promise<void>;

interface CommandContext {
  activeTicker: string | null;
  activeCollectionId: string | null;
}

export interface Command {
  id: string;
  prefix: string;        // e.g., "DES", "AW", "RP"
  aliases?: string[];
  label: string;
  description: string;
  hasArg?: boolean;       // true if prefix takes an argument (e.g., "DES AMD")
  argPlaceholder?: string;
  shortcut?: string;
  category: string;
  execute?: CommandExecutor;
}

export const commands: Command[] = [
  // Security description
  {
    id: "security-description",
    prefix: "DES",
    aliases: ["T"],
    label: "Description",
    description: "Open security details for a ticker",
    hasArg: true,
    argPlaceholder: "ticker",
    category: "Search",
  },
  {
    id: "help",
    prefix: "HELP",
    label: "Help",
    description: "Open the help window",
    category: "Navigation",
  },

  // Watchlist/Portfolio management
  {
    id: "add-watchlist",
    prefix: "AW",
    label: "Add to Watchlist",
    description: "Add current ticker to active watchlist",
    hasArg: true,
    argPlaceholder: "ticker",
    category: "Portfolio",
  },
  {
    id: "add-portfolio",
    prefix: "AP",
    label: "Add to Portfolio",
    description: "Add current ticker to active portfolio",
    hasArg: true,
    argPlaceholder: "ticker",
    category: "Portfolio",
  },
  {
    id: "remove-watchlist",
    prefix: "RW",
    label: "Remove from Watchlist",
    description: "Remove current ticker from active watchlist",
    hasArg: true,
    argPlaceholder: "ticker",
    category: "Portfolio",
  },
  {
    id: "remove-portfolio",
    prefix: "RP",
    label: "Remove from Portfolio",
    description: "Remove current ticker from active portfolio",
    hasArg: true,
    argPlaceholder: "ticker",
    category: "Portfolio",
  },
  {
    id: "set-portfolio-position",
    prefix: "",
    label: "Set Portfolio Position",
    description: "Create or update a manual position in a portfolio",
    category: "Portfolio",
  },

  // Create / Delete
  {
    id: "new-portfolio",
    prefix: "",
    label: "New Portfolio",
    description: "Create a new portfolio",
    category: "Create",
  },
  {
    id: "new-watchlist",
    prefix: "",
    label: "New Watchlist",
    description: "Create a new watchlist",
    category: "Create",
  },
  {
    id: "delete-portfolio",
    prefix: "",
    label: "Delete Portfolio",
    description: "Remove a portfolio and its data",
    category: "Danger",
  },
  {
    id: "delete-watchlist",
    prefix: "",
    label: "Delete Watchlist",
    description: "Remove a watchlist",
    category: "Danger",
  },
  {
    id: "add-broker-account",
    prefix: "",
    label: "Add Broker Account",
    description: "Connect a new broker profile",
    category: "Config",
  },
  {
    id: "disconnect-broker-account",
    prefix: "",
    label: "Disconnect Broker Account",
    description: "Remove one connected broker profile and its imported data",
    category: "Danger",
  },

  {
    id: "pane-settings",
    prefix: "PS",
    label: "Pane Settings",
    description: "Edit settings for the focused pane",
    category: "Config",
  },
  {
    id: "layout-marketplace",
    prefix: "LAY",
    label: "Layouts",
    description: "Open the layout browser to switch, publish, or add layouts",
    category: "Config",
  },
  {
    id: "layout",
    prefix: "LMA",
    label: "Layout Actions",
    description: "Organize panes and saved layouts",
    hasArg: true,
    argPlaceholder: "action",
    category: "Config",
  },
  {
    id: "window-mode",
    prefix: "WIN",
    aliases: ["WM"],
    label: "Window Mode",
    description: "Move or resize the focused window",
    hasArg: true,
    argPlaceholder: "move|resize",
    category: "Config",
  },
  {
    id: "toggle-status-bar",
    prefix: "SB",
    label: "Toggle Status Bar",
    description: "Show or hide the keyboard shortcuts bar",
    category: "Config",
    execute: (dispatch) => {
      dispatch({ type: "TOGGLE_STATUS_BAR" });
    },
  },
  {
    id: "toggle-value-flashing",
    prefix: "VF",
    label: "Toggle Value Flashing",
    description: "Turn quote update flashing on or off",
    category: "Config",
  },
  {
    id: "font-size-increase",
    prefix: "FONT+",
    label: "Increase Font Size",
    description: "Increase the app-wide font size",
    category: "Config",
  },
  {
    id: "font-size-decrease",
    prefix: "FONT-",
    label: "Decrease Font Size",
    description: "Decrease the app-wide font size",
    category: "Config",
  },
  {
    id: "check-for-updates",
    prefix: "",
    label: "Check for Updates",
    description: "Check GitHub releases for a newer version",
    category: "Config",
  },

  // Theme
  {
    id: "theme",
    prefix: "TH",
    label: "Change Theme",
    description: "Switch color theme",
    hasArg: true,
    argPlaceholder: "theme name",
    category: "Config",
  },
  {
    id: "cycle-chart-renderer",
    prefix: "CR",
    label: "Cycle Chart Renderer",
    description: "Cycle chart rendering between Auto, Kitty, and Braille",
    category: "Config",
  },
  {
    id: "language",
    prefix: "LANG",
    label: "Change Language",
    description: "Switch the interface language",
    hasArg: true,
    argPlaceholder: "locale",
    category: "Config",
  },

  // Import/Export
  {
    id: "export-config",
    prefix: "",
    label: "Export Config",
    description: "Save config to ~/gloomberb-config-backup.json",
    category: "Config",
  },
  {
    id: "import-config",
    prefix: "",
    label: "Import Config",
    description: "Load config from ~/gloomberb-config-backup.json",
    category: "Config",
  },

  // Danger zone
  {
    id: "reset-all-data",
    prefix: "",
    label: "Reset All Data",
    description: "Delete all data and reset to first-run state",
    category: "Danger",
  },
];

/** Find a command whose prefix matches the start of the input */
export function matchPrefix(input: string, commandList: Command[] = commands): { command: Command; arg: string; prefix: string } | null {
  const upper = input.toUpperCase().trim();
  if (!upper) return null;

  // Sort by prefix length descending so longer prefixes match first (e.g., "AW" before "A")
  const sorted = commandList
    .flatMap((command) => getCommandPrefixes(command).map((prefix) => ({ command, prefix })))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { command, prefix } of sorted) {
    if (upper.startsWith(`${prefix} `) || upper === prefix) {
      const arg = input.slice(prefix.length).trim();
      return { command, arg, prefix };
    }
  }

  return null;
}

export function getCommandPrefixes(command: Command): string[] {
  return [command.prefix, ...(command.aliases ?? [])]
    .map((prefix) => prefix.trim().toUpperCase())
    .filter(Boolean);
}
