import type { CommandDef } from "../../types/plugin";
import type { CommandBarRoute } from "./workflow/types";
import type { CollectionKind, CollectionMembershipAction } from "./workflow/ops";

export {
  buildGeneratedTemplateField,
  coerceFieldBoolean,
  coerceFieldString,
  coerceFieldValues,
  getFirstVisibleFieldId,
  getVisibleWorkflowFields,
  normalizeFieldOptions,
  normalizeWizardFields,
  summarizeWorkflowFieldValue,
} from "./workflow/fields";

export type RouteCommandId = "security-description" | "layout";
export type CollectionCommandId = "add-watchlist" | "add-portfolio" | "remove-watchlist" | "remove-portfolio";

export function isRouteCommandId(commandId: string): commandId is RouteCommandId {
  return commandId === "security-description"
    || commandId === "layout";
}

export function routeCommandIdToScreen(commandId: RouteCommandId): "ticker-search" | "layout" {
  switch (commandId) {
    case "security-description":
      return "ticker-search";
    case "layout":
      return "layout";
  }
}

export function isCollectionCommand(commandId: string): commandId is CollectionCommandId {
  return commandId === "add-watchlist"
    || commandId === "add-portfolio"
    || commandId === "remove-watchlist"
    || commandId === "remove-portfolio";
}

export function getCollectionCommandKind(commandId: CollectionCommandId): CollectionKind {
  return commandId === "add-watchlist" || commandId === "remove-watchlist" ? "watchlist" : "portfolio";
}

export function getCollectionCommandAction(commandId: CollectionCommandId): CollectionMembershipAction {
  return commandId === "add-watchlist" || commandId === "add-portfolio" ? "add" : "remove";
}

export function getCollectionCommandVerb(action: CollectionMembershipAction): string {
  return action === "add" ? "Add" : "Remove";
}

export function getScreenFooterLeft(_route: CommandBarRoute | null): string {
  return "up/down move  enter select";
}

export function getScreenFooterRight(route: CommandBarRoute | null): string {
  if (!route) return "esc cancel";

  if (route.query.trim().length > 0) {
    return "backspace delete  esc back";
  }

  return "backspace/esc back";
}

export function summarizeError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || "",
    };
  }
  return { message: String(error) };
}

export function looksDestructiveCommand(
  command: Pick<CommandDef, "id" | "label" | "description" | "keywords">,
): boolean {
  const haystack = [
    command.id,
    command.label,
    command.description || "",
    ...(command.keywords || []),
  ].join(" ").toLowerCase();
  return /\b(delete|remove|disconnect|reset|close)\b/.test(haystack);
}
