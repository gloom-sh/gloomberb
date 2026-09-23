import {
  ELECTROBUN_APPLICATION_MENU_ACTION,
  type ElectrobunApplicationMenuCommand,
} from "./index";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function applicationMenuClickPayload(event: unknown): Record<string, unknown> | null {
  const eventRecord = record(event);
  if (!eventRecord) return null;

  const wrappedPayload = record(eventRecord.data);
  if (typeof wrappedPayload?.action === "string") {
    return wrappedPayload;
  }

  return typeof eventRecord.action === "string" ? eventRecord : null;
}

function normalizeApplicationMenuCommand(value: unknown): ElectrobunApplicationMenuCommand | null {
  const command = record(value);
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
    case "quit":
      return { type: command.type };
    default:
      return null;
  }
}

export function applicationMenuCommand(event: unknown): ElectrobunApplicationMenuCommand | null {
  const payload = applicationMenuClickPayload(event);
  if (payload?.action !== ELECTROBUN_APPLICATION_MENU_ACTION) return null;
  return normalizeApplicationMenuCommand(payload.data);
}
