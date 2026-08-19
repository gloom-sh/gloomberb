import type { PaneDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import {
  buildCreateOptions,
  normalizeLookupToken,
  type ParsedPaneCatalogArgs,
} from "./options";
import {
  capabilityOptionSummary,
  getPaneFunctionCapability,
  type PaneFunctionCapability,
} from "./capabilities";

export interface PaneFunctionCatalog {
  panes: ReadonlyMap<string, PaneDef>;
  paneTemplates: ReadonlyMap<string, PaneTemplateDef>;
  destroy(): void;
}

export interface PaneCatalogEntry {
  token: string;
  label: string;
  description: string;
  paneId: string;
  paneName: string;
  templateId?: string;
  shortcut?: string;
  argKind?: string;
  argPlaceholder?: string;
  keywords: string[];
  defaultSettings: Record<string, unknown>;
  capability: PaneFunctionCapability;
}

export function buildTemplateContext(context: MarketContext, symbol: string | null) {
  return {
    config: context.config,
    layout: context.config.layout,
    focusedPaneId: null,
    activeTicker: symbol,
    activeCollectionId: null,
  };
}

function registerResolverToken(
  lookup: Map<string, PaneTemplateDef | PaneDef>,
  token: string | undefined,
  value: PaneTemplateDef | PaneDef,
) {
  if (!token) return;
  const normalized = normalizeLookupToken(token);
  if (!normalized || lookup.has(normalized)) return;
  lookup.set(normalized, value);
}

export function buildPaneFunctionLookup(registry: PaneFunctionCatalog): Map<string, PaneTemplateDef | PaneDef> {
  const lookup = new Map<string, PaneTemplateDef | PaneDef>();
  // Shortcut prefixes first: "AI" must open the pane that owns the shortcut, not
  // one that happens to list "ai" as a keyword.
  for (const template of registry.paneTemplates.values()) {
    registerResolverToken(lookup, template.shortcut?.prefix, template);
  }
  for (const template of registry.paneTemplates.values()) {
    registerResolverToken(lookup, template.id, template);
    registerResolverToken(lookup, template.label, template);
    for (const keyword of template.keywords ?? []) registerResolverToken(lookup, keyword, template);
  }

  for (const pane of registry.panes.values()) {
    registerResolverToken(lookup, pane.id, pane);
    registerResolverToken(lookup, pane.name, pane);
  }

  const financialTemplate = registry.paneTemplates.get("financial-analysis-pane");
  if (financialTemplate) {
    lookup.set(normalizeLookupToken("financials"), financialTemplate);
    lookup.set(normalizeLookupToken("financial-statements"), financialTemplate);
    lookup.set(normalizeLookupToken("financial-statement"), financialTemplate);
  }

  return lookup;
}

function sampleArgForTemplate(template: PaneTemplateDef): string {
  switch (template.shortcut?.argKind) {
    case "ticker":
      return "AAPL";
    case "ticker-list":
      return "AAPL,MSFT";
    case "text":
      return "sample";
    default:
      return "";
  }
}

function formatCatalogSettings(settings: Record<string, unknown>): string {
  const entries = Object.entries(settings)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length > 0 ? entries.join(", ") : "none";
}

async function buildTemplateCatalogEntry(
  template: PaneTemplateDef,
  pane: PaneDef,
  context: MarketContext,
): Promise<PaneCatalogEntry> {
  const sampleArg = sampleArgForTemplate(template);
  const createOptions: PaneTemplateCreateOptions | undefined = buildCreateOptions(template, sampleArg);
  const primarySymbol = createOptions?.symbol ?? createOptions?.symbols?.[0] ?? null;
  let defaultSettings: Record<string, unknown> = {};

  if (template.createInstance) {
    try {
      const spec = await template.createInstance(buildTemplateContext(context, primarySymbol), createOptions);
      defaultSettings = spec?.settings ?? {};
    } catch {
      defaultSettings = {};
    }
  }

  return {
    token: template.shortcut?.prefix ?? template.id,
    label: template.label,
    description: template.description,
    paneId: pane.id,
    paneName: pane.name,
    templateId: template.id,
    shortcut: template.shortcut?.prefix,
    argKind: template.shortcut?.argKind,
    argPlaceholder: template.shortcut?.argPlaceholder,
    keywords: template.keywords ?? [],
    defaultSettings,
    capability: getPaneFunctionCapability(template, pane),
  };
}

export async function buildPaneCatalogEntries(
  registry: PaneFunctionCatalog,
  context: MarketContext,
): Promise<PaneCatalogEntry[]> {
  const entries: PaneCatalogEntry[] = [];
  const templatedPaneIds = new Set<string>();

  for (const template of registry.paneTemplates.values()) {
    const pane = registry.panes.get(template.paneId);
    if (!pane) continue;
    templatedPaneIds.add(pane.id);
    entries.push(await buildTemplateCatalogEntry(template, pane, context));
  }

  for (const pane of registry.panes.values()) {
    if (templatedPaneIds.has(pane.id)) continue;
    entries.push({
      token: pane.id,
      label: pane.name,
      description: `Open the ${pane.name} pane.`,
      paneId: pane.id,
      paneName: pane.name,
      keywords: [],
      defaultSettings: {},
      capability: getPaneFunctionCapability(undefined, pane),
    });
  }

  return entries.sort((left, right) => left.token.localeCompare(right.token));
}

function paneCatalogSearchScore(entry: PaneCatalogEntry, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) return 1;

  const exactTokens = [
    entry.token,
    entry.shortcut,
    entry.templateId,
    entry.paneId,
  ].filter((value): value is string => !!value).map((value) => normalizeLookupToken(value));
  const searchable = [
    entry.token,
    entry.label,
    entry.description,
    entry.paneId,
    entry.paneName,
    entry.templateId,
    entry.shortcut,
    entry.argKind,
    entry.argPlaceholder,
    ...entry.keywords,
    ...entry.capability.aliases,
    ...entry.capability.intents,
    entry.capability.outputKind,
    ...entry.capability.options.flatMap((option) => [
      option.key,
      option.description,
      ...(option.aliases ?? []),
      ...(option.values ?? []).flatMap((value) => [value.value, ...(value.aliases ?? [])]),
    ]),
    ...Object.keys(entry.defaultSettings),
  ].filter((value): value is string => !!value).join(" ").toLowerCase();

  let score = searchable.includes(query.toLowerCase()) ? 12 : 0;
  let matchedTerms = 0;
  for (const term of terms) {
    const normalized = normalizeLookupToken(term);
    if (exactTokens.includes(normalized)) {
      score += 8;
      matchedTerms += 1;
    } else if (searchable.includes(term)) {
      score += 2;
      matchedTerms += 1;
    } else if (searchable.includes(normalized)) {
      score += 1;
      matchedTerms += 1;
    }
  }

  if (matchedTerms === 0) return 0;
  score += Math.round((matchedTerms / terms.length) * 8);
  if (entry.capability.botSafe) score += 2;
  return score;
}

export function filterPaneCatalogEntries(entries: PaneCatalogEntry[], query: string): PaneCatalogEntry[] {
  return entries
    .map((entry) => ({ entry, score: paneCatalogSearchScore(entry, query) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.entry.token.localeCompare(right.entry.token))
    .map(({ entry }) => entry);
}

export function renderPaneCatalogReport(entries: PaneCatalogEntry[], args: ParsedPaneCatalogArgs): string {
  const shown = entries.slice(0, args.limit);
  const lines = [
    "Gloomberb Function Catalog",
    "",
    "Use:",
    "  gloomberb fn <shortcut-or-pane> [argument] [--key value]",
    "  gloomberb shot <shortcut-or-pane> [argument] [--output path] [--key value]",
    "",
    args.query
      ? `Matches for "${args.query}" (${shown.length}${entries.length > shown.length ? ` of ${entries.length}` : ""})`
      : `Available pane functions (${shown.length}${entries.length > shown.length ? ` of ${entries.length}` : ""})`,
    "",
  ];

  if (shown.length === 0) {
    lines.push("No matching pane functions.");
    return lines.join("\n");
  }

  for (const entry of shown) {
    const arg = entry.argPlaceholder ? `<${entry.argPlaceholder}>` : entry.argKind ? `<${entry.argKind}>` : "[argument]";
    lines.push(`${entry.token} | ${entry.label}`);
    lines.push(`  Description: ${entry.description}`);
    lines.push(`  Pane: ${entry.paneId} (${entry.paneName})`);
    if (entry.templateId) lines.push(`  Template: ${entry.templateId}`);
    if (entry.shortcut) lines.push(`  Shortcut: ${entry.shortcut}`);
    if (entry.argKind) lines.push(`  Argument: ${entry.argKind}${entry.argPlaceholder ? ` (${entry.argPlaceholder})` : ""}`);
    if (entry.keywords.length > 0) lines.push(`  Keywords: ${entry.keywords.join(", ")}`);
    lines.push(`  Bot safe: ${entry.capability.botSafe ? "yes" : "no"}`);
    lines.push(`  Output: ${entry.capability.outputKind}`);
    lines.push(`  Readiness: report=${entry.capability.reportReadiness}, screenshot=${entry.capability.screenshotReadiness}`);
    if (entry.capability.aliases.length > 0) lines.push(`  Aliases: ${entry.capability.aliases.join(", ")}`);
    if (entry.capability.intents.length > 0) lines.push(`  Intents: ${entry.capability.intents.join("; ")}`);
    const optionSummary = capabilityOptionSummary(entry.capability);
    if (optionSummary.length > 0) lines.push(`  Options: ${optionSummary.join(", ")}`);
    if (entry.capability.dataRequirements.length > 0) {
      lines.push(`  Requires: ${entry.capability.dataRequirements.join(", ")}`);
    }
    if (entry.capability.limitations.length > 0) {
      lines.push(`  Limitations: ${entry.capability.limitations.join(" ")}`);
    }
    lines.push(`  Defaults: ${formatCatalogSettings(entry.defaultSettings)}`);
    lines.push(`  Examples: gloomberb fn ${entry.token} ${arg} | gloomberb shot ${entry.token} ${arg} --output /tmp/${entry.token.toLowerCase()}.png`);
    lines.push("");
  }

  lines.push("Use --require-bot-safe to reject unverified functions and undeclared options. Generic UI screenshots may also accept --tab, --activeTabId, and --state options.");
  return lines.join("\n").trimEnd();
}
