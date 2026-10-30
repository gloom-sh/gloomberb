import type { HeadlessPaneDefinition, PaneDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../types/plugin";
import { parseTickerListInput } from "../../tickers/list";
import { normalizeTickerInput } from "../../tickers/search";
import { resolveFinancialPeriodOption } from "../../plugins/builtin/ticker-detail/financials/model";
import {
  FINANCIAL_SECTIONS,
  RATIO_TAB_KEYS,
  resolveFinancialSectionKey,
} from "../../plugins/builtin/ticker-detail/financials/ratios";
import type { PaneRuntimeState } from "../../core/state/app/state";
import type { NormalizedPaneFunctionOptions } from "./capabilities";
import type { CliListing } from "../listing-arg";
import { splitSymbolWords } from "../symbol-args";
import { numberErrorMessage } from "../../utils/decimal-comma";

const DEFAULT_SHOT_WIDTH = 1280;
const DEFAULT_SHOT_HEIGHT = 720;
/** The layout sizes `shot` takes, in CSS pixels; the PNG is drawn at twice that. */
export const SHOT_SIZE_LIMITS = {
  width: { min: 720, max: 2400 },
  height: { min: 360, max: 1800 },
} as const;

/** A `--width` or `--height` outside its limits, and the size the capture used instead. */
export interface ShotSizeClamp {
  dimension: "width" | "height";
  requested: number;
  used: number;
}
const DEFAULT_CATALOG_LIMIT = 25;

export interface ParsedPaneFunctionArgs {
  target: string;
  arg: string;
  options: Record<string, string | true>;
  outputPath: string | null;
  width: number;
  height: number;
  /** `--height` was given; without it a pane that fits its rows (FUT) grows to show them all. */
  heightGiven?: true;
  /** Theme id override for screenshots; null keeps the configured theme. */
  theme: string | null;
  /** Render scale: 1.5 renders two thirds as many cells at 1.5x size, so text reads larger at the same pixel size. */
  scale: number;
  /** Small label drawn in the pane title bar, e.g. a domain; null draws nothing. */
  watermark: string | null;
  /** A screenshot carries its dated status line in the pane footer; `--no-status` sets this false. */
  status?: boolean;
  /** Sizes asked for outside the limits, so `shot` can say what it used instead. */
  clamped?: ShotSizeClamp[];
  /** `--explain`: follow a report with the meaning of the terms it shows. */
  explain?: boolean;
  requireBotSafe: boolean;
  /** `shot --strict`: exit with the unusable-shot code when the capture shows no usable data. */
  strict?: boolean;
  /** The options only `shot` reads (`--theme`, `--height`), as typed, which `fn` refuses rather than ignore. */
  shotOnly?: string[];
  /** The listing a one-ticker function's argument named, once `applyListingArgument` has resolved it. */
  listing?: CliListing;
  /**
   * What `applyListingArgument` says about a list's listings: what a typed
   * code was read as, and the ones left out of data that covers US listings only.
   */
  listingNotes?: string[];
}

export interface ParsedPaneCatalogArgs {
  query: string;
  limit: number;
  botSafeOnly: boolean;
}

function normalizeOptionKey(value: string): string {
  return value.trim().replace(/^-+/, "").replace(/[\s_-]+(.)/g, (_, char: string) => char.toUpperCase());
}

export function normalizeLookupToken(value: string): string {
  return value.trim().replace(/^\$/, "").toLowerCase().replace(/[\s_-]+/g, "");
}

export function cleanTickerInput(value: string): string {
  return value.trim().replace(/^\$/, "").toUpperCase();
}

/**
 * Whether a function's argument names the ticker its pane shows. Its report
 * says first: AUCT's `10Y` and IPO's `pending` are free text its own resolver
 * reads, never a symbol to look up. Without a report, a rendered pane whose
 * argument is an id it opens (the story pane's story id) says so, then the
 * shortcut.
 */
export function argumentNamesTicker(
  template: Pick<PaneTemplateDef, "shortcut"> | undefined,
  headless: Pick<HeadlessPaneDefinition, "argument"> | undefined,
  pane?: Pick<PaneDef, "reportArgument">,
): boolean {
  if (!headless && pane?.reportArgument?.identifier) return false;
  const kind = headless?.argument.kind;
  if (kind === "free-text" || kind === "none") return false;
  return kind === "tickers" || kind === "symbol-list" || template?.shortcut?.argKind !== "text";
}

export function parseArgumentsOption(value: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    pairs[normalizeOptionKey(trimmed.slice(0, equalsIndex))] = trimmed.slice(equalsIndex + 1).trim();
  }
  return pairs;
}

/** How many words one value of an option takes, by its key as parsed (`fxShift`); one when it is not a pair. */
export type OptionValueWords = (key: string) => number;

/** Words in the last value of a list (`TRY -20, EUR 5` ends with two); a decimal comma (`TRY -2,5`) separates nothing. */
const lastValueWords = (value: string) => value.split(/(?<!\d),|,(?!\d)/).at(-1)!.trim().split(/\s+/).filter(Boolean).length;

/**
 * What only `shot` draws: the capture's height, theme, text scale, watermark
 * and status line. `--width` is not one: on `fn` it is the CLI's table width.
 */
const SHOT_ONLY_KEYS = new Set(["height", "theme", "scale", "watermark"]);

export function parsePaneFunctionArgs(
  args: string[],
  globalOptions: { limit?: number; tail?: number } = {},
  valueWords?: OptionValueWords,
  /** Whether an option takes a list, so its flag typed again adds to it rather than replacing it. */
  listOption?: (key: string) => boolean,
): ParsedPaneFunctionArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  let outputPath: string | null = null;
  let width = DEFAULT_SHOT_WIDTH;
  let height = DEFAULT_SHOT_HEIGHT;
  let heightGiven = false;
  let theme: string | null = null;
  let scale = 1;
  let watermark: string | null = null;
  let status = true;
  let explain = false;
  let strict = false;
  let requireBotSafe = false;
  const clamped: ShotSizeClamp[] = [];
  const shotOnly: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    const key = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
    const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : undefined;
    // A switch: the token after it is the function's argument, never its value.
    if (normalizeOptionKey(key) === "noStatus" && inlineValue === undefined) {
      status = false;
      shotOnly.push(`--${key}`);
      continue;
    }
    if (normalizeOptionKey(key) === "explain" && inlineValue === undefined) {
      explain = true;
      continue;
    }
    if (normalizeOptionKey(key) === "strict" && inlineValue === undefined) {
      strict = true;
      continue;
    }
    const next = args[index + 1];
    const nextValue = inlineValue === undefined && next && !next.startsWith("--") ? args[++index] : true;
    let value: string | true = inlineValue ?? nextValue ?? true;
    const normalizedKey = normalizeOptionKey(key);
    if (SHOT_ONLY_KEYS.has(normalizedKey)) shotOnly.push(`--${key}`);
    // A value that is a pair (`--fx-shift TRY -20`) takes the words after it, and a list of them the words after a comma.
    const words = value === true ? 1 : valueWords?.(normalizedKey) ?? 1;
    if (words > 1 && value !== true) {
      while (index + 1 < args.length && !args[index + 1]!.startsWith("--")
        && (lastValueWords(value) < words || value.trimEnd().endsWith(","))) {
        value = `${value} ${args[++index]!}`;
      }
    }
    // A list's flag typed again adds to it: `--metric trailingPE --metric dividendYieldPercent`.
    if ((words > 1 || listOption?.(normalizedKey)) && value !== true) {
      const earlier = options[normalizedKey];
      if (typeof earlier === "string") value = `${earlier}, ${value}`;
    }
    if (normalizedKey === "requireBotSafe" || normalizedKey === "botSafe") {
      requireBotSafe = value === true || String(value).toLowerCase() === "true";
    } else if (normalizedKey === "output" || normalizedKey === "out" || normalizedKey === "o") {
      // A flag with no path is kept as an empty one, which `fn` refuses rather than print as if it had not been given.
      outputPath = value === true ? "" : value;
    } else if ((normalizedKey === "width" || normalizedKey === "height") && value !== true) {
      const size = parseShotSize(normalizedKey, value);
      if (size.used !== size.requested) clamped.push(size);
      if (normalizedKey === "width") width = size.used;
      else {
        height = size.used;
        heightGiven = true;
      }
    } else if (normalizedKey === "theme" && value !== true) {
      theme = value.trim() || null;
    } else if (normalizedKey === "scale" && value !== true) {
      scale = parseScale(value);
    } else if (normalizedKey === "watermark" && value !== true) {
      watermark = value.trim() || null;

    } else if (normalizedKey === "arguments" && value !== true) {
      Object.assign(options, parseArgumentsOption(value));
    } else {
      options[normalizedKey] = value;
    }
  }

  const target = positionals[0]?.trim() ?? "";
  const arg = positionals.slice(1).join(" ").trim();
  // The outer CLI parser consumes --limit and --tail before fn/shot sees its arguments.
  // Restore them for the pane's own schema and loader, including bounds checks,
  // so a function without a tail option says so instead of ignoring it.
  if (globalOptions.limit != null) options.limit = String(globalOptions.limit);
  if (globalOptions.tail != null) options.tail = String(globalOptions.tail);
  return {
    target, arg, options, outputPath, width, height, theme, scale, watermark, status, requireBotSafe,
    ...(clamped.length > 0 ? { clamped } : {}),
    ...(heightGiven ? { heightGiven: true as const } : {}),
    ...(explain ? { explain } : {}),
    ...(strict ? { strict } : {}),
    ...(shotOnly.length > 0 ? { shotOnly } : {}),
  };
}

/** A `--width` or `--height` in pixels, held to the limits `shot` can draw. */
function parseShotSize(dimension: "width" | "height", value: string): ShotSizeClamp {
  const { min, max } = SHOT_SIZE_LIMITS[dimension];
  const requested = Number(value);
  if (!value.trim() || !Number.isFinite(requested)) {
    throw new Error(`--${dimension} takes a size in pixels from ${min} to ${max}, got "${value}".`);
  }
  const rounded = Math.round(requested);
  return { dimension, requested: rounded, used: Math.max(min, Math.min(max, rounded)) };
}

export function parsePaneCatalogArgs(args: string[]): ParsedPaneCatalogArgs {
  const queryParts: string[] = [];
  let limit = DEFAULT_CATALOG_LIMIT;
  let botSafeOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      queryParts.push(...args.slice(index + 1));
      break;
    }

    if (token === "--all") {
      limit = Number.POSITIVE_INFINITY;
      continue;
    }

    if (token === "--bot-safe" || token === "--botsafe") {
      botSafeOnly = true;
      continue;
    }

    if (token === "--limit") {
      const parsed = Number(args[++index]);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.max(1, Math.round(parsed));
      }
      continue;
    }

    if (token.startsWith("--limit=")) {
      const parsed = Number(token.slice("--limit=".length));
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.max(1, Math.round(parsed));
      }
      continue;
    }

    queryParts.push(token);
  }

  return {
    query: queryParts.join(" ").trim(),
    limit,
    botSafeOnly,
  };
}

type PaneOptionValues = Record<string, string | number | boolean>;

function optionString(options: PaneOptionValues, key: string): string | undefined {
  const value = options[normalizeOptionKey(key)];
  return value === true || value === undefined ? undefined : String(value);
}

const RESERVED_OPTION_KEYS = new Set([
  "output", "out", "o", "width", "height", "theme", "scale", "watermark", "arguments", "state",
]);

function parseScale(value: string): number {
  const parsed = Number.parseFloat(value);
  // parseFloat reads "2,5" as 2, so a comma is refused before it can pass.
  if (value.includes(",") || !Number.isFinite(parsed) || parsed < 0.5 || parsed > 4) {
    throw new Error(numberErrorMessage(`--scale must be a number between 0.5 and 4, got "${value}".`, value));
  }
  return parsed;
}

export function optionSettings(options: Record<string, string | true>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (RESERVED_OPTION_KEYS.has(key) || key.startsWith("state.")) continue;
    settings[key] = value === true ? true : coerceSettingValue(value);
  }
  return settings;
}

function coerceSettingValue(value: string): unknown {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function buildCreateOptions(
  template: PaneTemplateDef | undefined,
  arg: string,
): PaneTemplateCreateOptions | undefined {
  if (!template && !arg) return undefined;
  const values: Record<string, string> = {};
  const createOptions: PaneTemplateCreateOptions = arg ? { arg } : {};
  const argPlaceholder = template?.shortcut?.argPlaceholder;
  if (argPlaceholder && arg) values[argPlaceholder] = arg;

  if (template?.shortcut?.argKind === "ticker") {
    const symbol = normalizeTickerInput(null, cleanTickerInput(arg));
    createOptions.symbol = symbol;
    if (symbol) createOptions.arg = symbol;
  } else if (template?.shortcut?.argKind === "ticker-list") {
    const raw = arg.replace(/\$/g, "");
    createOptions.arg = raw;
    try {
      createOptions.symbols = parseTickerListInput(raw);
    } catch {
      // Past the list limit, every symbol stays: a pasted list splits as `quote` splits it.
      createOptions.symbols = splitSymbolWords([raw]).map(cleanTickerInput);
    }
  }

  if (Object.keys(values).length > 0) createOptions.values = values;
  return createOptions;
}

function normalizeFinancialSubTabOption(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (normalized === "cf" || normalized === "cashflows") return "cashflow";
  if (normalized === "bs" || normalized === "balancesheet") return "balance";
  const section = resolveFinancialSectionKey(value);
  return FINANCIAL_SECTIONS.find((tab) => (
    tab.key.toLowerCase() === normalized
    || tab.name.toLowerCase().replace(/[\s_-]+/g, "") === normalized
  ))?.key ?? (RATIO_TAB_KEYS.has(section) ? section : undefined);
}

export function optionPaneState(options: PaneOptionValues | NormalizedPaneFunctionOptions): PaneRuntimeState {
  const state: PaneRuntimeState = {};
  const rawState = optionString(options, "state");
  if (rawState) {
    for (const [key, value] of Object.entries(parseArgumentsOption(rawState))) {
      state[key] = coerceSettingValue(value);
    }
  }

  for (const [key, value] of Object.entries(options)) {
    if (!key.startsWith("state.") || value === true) continue;
    state[key.slice("state.".length)] = typeof value === "string" ? coerceSettingValue(value) : value;
  }

  const activeTab = optionString(options, "activeTabId")
    ?? optionString(options, "activeTab")
    ?? optionString(options, "paneTab");
  if (activeTab) state.activeTabId = activeTab;

  const tab = optionString(options, "tab");
  const financialTab = normalizeFinancialSubTabOption(
    optionString(options, "statement")
      ?? optionString(options, "financialStatement")
      ?? tab,
  );
  if (financialTab) {
    state.financialSubTab = financialTab;
  } else if (tab) {
    state.activeTabId = tab;
  }

  const period = resolveFinancialPeriodOption(optionString(options, "period") ?? optionString(options, "financialPeriod"));
  if (period) state.financialPeriod = period;

  return state;
}
