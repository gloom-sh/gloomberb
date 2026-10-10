import type { CliCommandContext } from "../../types/plugin";

export function takeOption(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equalsIndex = args.findIndex((arg) => arg.startsWith(equalsPrefix));
  if (equalsIndex >= 0) {
    const [value] = args.splice(equalsIndex, 1);
    return value!.slice(equalsPrefix.length);
  }

  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, value == null ? 1 : 2);
  return value;
}

/** Removes a boolean flag (`--history`) from `args` and says whether it was there. */
export function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export function parseJsonPayload(value: string | undefined, ctx: CliCommandContext): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (error) {
    ctx.fail("Payload must be valid JSON.", error instanceof Error ? error.message : String(error));
  }
}

export function parsePositiveInt(value: string | undefined, fallback: number, label: string, ctx: CliCommandContext): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    ctx.fail(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function requireArg(value: string | undefined, usage: string, ctx: CliCommandContext): string {
  if (!value) ctx.fail(usage);
  return value;
}

/**
 * Fails on arguments past the `max` a command takes rather than dropping them:
 * `fx NGN ZAR` printing NGN alone reads as an answer for both. `usage` is the
 * command's usage line without `gloomberb`, `takes` what it takes ("one
 * currency", "no arguments").
 */
export function rejectExtraArgs(
  args: readonly string[],
  max: number,
  { usage, takes, advice }: { usage: string; takes: string; advice?: string },
  ctx: Pick<CliCommandContext, "fail">,
): void {
  if (args.length <= max) return;
  const command = usage.split(" ")[0];
  ctx.fail(`${command} takes ${takes}; got ${args.join(" ")}.`, [advice, `Usage: gloomberb ${usage}`].filter(Boolean).join("\n"));
}

/** The one argument a command takes, such as a symbol: missing fails with the usage line, extras are not dropped. */
export function requireOneArg(
  args: readonly string[],
  usage: string,
  noun: string,
  ctx: CliCommandContext,
): string {
  const value = requireArg(args[0], `Usage: gloomberb ${usage}`, ctx);
  rejectExtraArgs(args, 1, { usage, takes: `one ${noun}`, advice: `Run it once per ${noun}.` }, ctx);
  return value;
}

export function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return "";
}
