import {
  ELECTROBUN_APPLICATION_MENU_ACTION,
  type ElectrobunApplicationMenuCommand,
} from "./index";
import { recordOrNull } from "../../../../utils/guards";
import { createOneShots } from "../../../../utils/one-shot";
import { menuClickPayload } from "../menu-event";

function normalizeApplicationMenuCommand(value: unknown): ElectrobunApplicationMenuCommand | null {
  const command = recordOrNull(value);
  if (!command || typeof command.type !== "string") return null;

  switch (command.type) {
    case "open-command-bar":
      if (command.query != null && typeof command.query !== "string") return null;
      return command.query == null
        ? { type: "open-command-bar" }
        : { type: "open-command-bar", query: command.query };
    case "open-plugin-workflow":
      return typeof command.commandId === "string" && command.commandId.length > 0
        ? { type: "open-plugin-workflow", commandId: command.commandId }
        : null;
    case "open-builtin-workflow":
      return typeof command.actionId === "string" && command.actionId.length > 0
        ? { type: "open-builtin-workflow", actionId: command.actionId }
        : null;
    case "open-url":
      return typeof command.url === "string" && command.url.length > 0
        ? { type: "open-url", url: command.url }
        : null;
    case "check-for-updates":
    case "toggle-status-bar":
    case "open-layout-gallery":
    case "layout-undo":
    case "layout-redo":
    case "layout-gridlock":
    case "open-devtools":
    case "new-window":
    case "quit":
      return { type: command.type };
    default:
      return null;
  }
}

export function applicationMenuCommand(event: unknown): ElectrobunApplicationMenuCommand | null {
  const payload = menuClickPayload(event);
  if (payload?.action !== ELECTROBUN_APPLICATION_MENU_ACTION) return null;
  return normalizeApplicationMenuCommand(payload.data);
}

/**
 * Holding a menu accelerator (Cmd+Shift+L, Cmd+K) makes the system click its
 * item again about thirty times a second, and the click that reaches the Bun
 * process says nothing about being a repeat. Each command runs once, then not
 * again until none has come for a cooldown: a held key stays refused, and
 * nothing queues up to run after it is released.
 */
export function createApplicationMenuGate(options?: { cooldownMs?: number; now?: () => number }) {
  const shots = createOneShots(options);
  return (command: ElectrobunApplicationMenuCommand): boolean => {
    const shot = shots.get(JSON.stringify(command));
    if (shot.refuses()) return false;
    shot.end();
    return true;
  };
}
