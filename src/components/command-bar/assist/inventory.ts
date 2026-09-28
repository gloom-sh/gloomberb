import type { AssistCommandDescriptor } from "../../../api-client";
import type { CommandDef, PaneTemplateDef, ShortcutArgOption } from "../../../types/plugin";
import { getCommandPrefixes, type Command } from "../commands/registry";
import { getPaneTemplateDisplayLabel, paneTemplateShortcutPrefixes } from "../pane-templates/items";
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

interface InventoryEntry {
  descriptor: AssistCommandDescriptor | null;
  /** Every prefix the shortcut parser resolves to this source: its own and its aliases. */
  prefixes: readonly string[];
}

function describeArg(
  kind: RootShortcutArgKind | null,
  placeholder: string | undefined,
  { optional, options }: { optional?: boolean; options?: () => readonly ShortcutArgOption[] } = {},
): AssistCommandDescriptor["arg"] {
  if (!kind) return undefined;
  const trimmed = placeholder?.trim();
  const values = options?.().map(({ value, label }) => ({ value, label }));
  return {
    kind,
    ...(trimmed ? { placeholder: trimmed } : {}),
    ...(optional ? { optional: true } : {}),
    ...(values?.length ? { options: values } : {}),
  };
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

function normalizePrefixes(prefixes: readonly string[]): string[] {
  return prefixes.map((prefix) => prefix.trim().toUpperCase()).filter(Boolean);
}

/**
 * Flattens the command bar's prefix language into the shape `/assist/command`
 * expects. Sources are visited in the same order the shortcut parser resolves
 * them (built-in commands, plugin commands, pane templates), and a prefix goes
 * to the first source that claims it, as its own or as an alias. An entry whose
 * prefix an earlier source already claims is dropped, since the bar would run
 * that source instead ("T" opens DES, not the Ticker Research template).
 * Aliases are otherwise omitted: the assistant should teach one canonical
 * prefix per command.
 */
export function buildAssistCommandInventory({
  commands,
  pluginCommands,
  paneTemplates,
  limit = ASSIST_INVENTORY_LIMIT,
}: AssistInventorySource): AssistCommandDescriptor[] {
  const entries: InventoryEntry[] = [
    ...commands.map((command) => ({
      descriptor: describe(
        command.prefix,
        command.label,
        command.description,
        describeArg(getCommandShortcutArgKind(command), command.argPlaceholder, { options: command.argOptions }),
      ),
      prefixes: getCommandPrefixes(command),
    })),
    ...pluginCommands.map((command) => ({
      descriptor: describe(
        command.shortcut ?? "",
        command.label,
        command.description,
        describeArg(getPluginCommandShortcutArgKind(command), command.shortcutArg?.placeholder),
      ),
      prefixes: normalizePrefixes(command.shortcut ? [command.shortcut] : []),
    })),
    ...paneTemplates.map((template) => ({
      descriptor: describe(
        template.shortcut?.prefix ?? "",
        getPaneTemplateDisplayLabel(template),
        template.shortcut?.aliases?.length ? `${template.description} Also ${template.shortcut.aliases.join(", ")}.` : template.description,
        describeArg(getPaneShortcutArgKind(template), template.shortcut?.argPlaceholder, {
          optional: template.shortcut?.argOptional,
          options: template.shortcut?.argOptions,
        }),
      ),
      prefixes: normalizePrefixes(paneTemplateShortcutPrefixes(template)),
    })),
  ];

  const claimedPrefixes = new Set<string>();
  const inventory: AssistCommandDescriptor[] = [];
  for (const { descriptor, prefixes } of entries) {
    const shadowed = !descriptor || claimedPrefixes.has(descriptor.prefix);
    for (const prefix of prefixes) claimedPrefixes.add(prefix);
    if (shadowed) continue;
    inventory.push(descriptor);
    if (inventory.length >= limit) break;
  }
  return inventory;
}
