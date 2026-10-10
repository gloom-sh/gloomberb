import { FUNCTION_HELP, type FunctionAccess } from "../cli/pane-functions/function-help";
import { commands as coreCommands, getCommandPrefixes } from "../components/command-bar/commands/registry";
import { BUILTIN_EDITORIAL } from "./builtin-editorial";

/** A command-bar function a plugin adds, as the Plugins pane and gloom.sh list it. */
export interface PluginFunction {
  code: string;
  name: string;
  description: string;
  access?: FunctionAccess;
}

interface FunctionSources {
  templates: ReadonlyArray<{ label: string; prefix?: string; description?: string }>;
  commands?: ReadonlyArray<{ label: string; shortcut?: string; description?: string }>;
}

/** The core command an alias belongs to: the research pane's T is DES. */
const CORE_PRIMARY = new Map(coreCommands.flatMap((command) => {
  const [primary, ...aliases] = getCommandPrefixes(command);
  return primary ? aliases.map((alias) => [alias, primary] as const) : [];
}));

/**
 * The functions a plugin answers to, once each, in the order it registered
 * them: its pane templates, then its commands. A code that is an alias of a
 * core command is listed under the code people type.
 */
export function pluginFunctions({ templates, commands = [] }: FunctionSources): PluginFunction[] {
  const byCode = new Map<string, PluginFunction>();
  const add = (rawCode: string | undefined, name: string, description = "") => {
    const typed = rawCode?.trim().toUpperCase();
    if (!typed) return;
    const code = CORE_PRIMARY.get(typed) ?? typed;
    if (byCode.has(code)) return;
    const access = FUNCTION_HELP[code]?.access;
    byCode.set(code, { code, name, description, ...(access ? { access } : {}) });
  };
  for (const template of templates) add(template.prefix, template.label, template.description);
  for (const command of commands) add(command.shortcut, command.label, command.description);
  return [...byCode.values()];
}

/** Functions Free cannot fully open: Pro only, or a preview on Free. */
export function proFunctionCount(functions: readonly PluginFunction[]): number {
  return functions.filter((fn) => fn.access).length;
}

/** The codes a row shows: the editorial pick when it names real codes, else the first three. */
export function highlightedCodes(pluginId: string, functions: readonly PluginFunction[]): string[] {
  const codes = functions.map((fn) => fn.code);
  const picked = (BUILTIN_EDITORIAL[pluginId]?.highlights ?? []).filter((code) => codes.includes(code));
  return (picked.length > 0 ? picked : codes).slice(0, 3);
}
