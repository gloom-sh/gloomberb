import type { AssistCommandDescriptor } from "../../../api-client";
import type { CommandDef, PaneTemplateDef } from "../../../types/plugin";
import type { Command } from "../commands/registry";
import { getPaneTemplateDisplayLabel } from "../pane-templates/items";
import {
  getCommandShortcutArgKind,
  getPaneShortcutArgKind,
  getPluginCommandShortcutArgKind,
  type RootShortcutArgKind,
} from "../routes/root/shortcuts";

/** Server cap on `/assist/command` inventories. */
const ASSIST_INVENTORY_LIMIT = 150;

interface AssistInventorySource {
  commands: readonly Command[];
  pluginCommands: readonly CommandDef[];
  paneTemplates: readonly PaneTemplateDef[];
  limit?: number;
}

function describeArg(
  kind: RootShortcutArgKind | null,
  placeholder: string | undefined,
): AssistCommandDescriptor["arg"] {
  if (!kind) return undefined;
  const trimmed = placeholder?.trim();
  return trimmed ? { kind, placeholder: trimmed } : { kind };
}

function describe(
  prefix: string,
  name: string,
  description: string | undefined,
  arg: AssistCommandDescriptor["arg"],
): AssistCommandDescriptor | null {
  const normalizedPrefix = prefix.trim().toUpperCase();
  const normalizedName = name.trim();
  if (!normalizedPrefix || !normalizedName) return null;
  const normalizedDescription = description?.trim();
  return {
    prefix: normalizedPrefix,
    name: normalizedName,
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    ...(arg ? { arg } : {}),
  };
}

/**
 * Flattens the command bar's prefix language into the shape `/assist/command`
 * expects. Sources are visited in the same order the shortcut parser resolves
 * them (built-in commands, plugin commands, pane templates), so the entry kept
 * for a duplicated prefix is the one the bar would actually run. Aliases are
 * omitted: the assistant should teach one canonical prefix per command.
 */
export function buildAssistCommandInventory({
  commands,
  pluginCommands,
  paneTemplates,
  limit = ASSIST_INVENTORY_LIMIT,
}: AssistInventorySource): AssistCommandDescriptor[] {
  const descriptors: Array<AssistCommandDescriptor | null> = [
    ...commands.map((command) => describe(
      command.prefix,
      command.label,
      command.description,
      describeArg(getCommandShortcutArgKind(command), command.argPlaceholder),
    )),
    ...pluginCommands.map((command) => describe(
      command.shortcut ?? "",
      command.label,
      command.description,
      describeArg(getPluginCommandShortcutArgKind(command), command.shortcutArg?.placeholder),
    )),
    ...paneTemplates.map((template) => describe(
      template.shortcut?.prefix ?? "",
      getPaneTemplateDisplayLabel(template),
      template.description,
      describeArg(getPaneShortcutArgKind(template), template.shortcut?.argPlaceholder),
    )),
  ];

  const seenPrefixes = new Set<string>();
  const inventory: AssistCommandDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor || seenPrefixes.has(descriptor.prefix)) continue;
    seenPrefixes.add(descriptor.prefix);
    inventory.push(descriptor);
    if (inventory.length >= limit) break;
  }
  return inventory;
}
