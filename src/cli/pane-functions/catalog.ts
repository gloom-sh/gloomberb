import type { PaneDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../types/plugin";
import type { MarketContext } from "../types";
import {
  buildCreateOptions,
  normalizeLookupToken,
  type ParsedPaneCatalogArgs,
} from "./options";
import {
  getHeadlessPaneDefinition,
  getPaneFunctionCapability,
  type PaneFunctionCapability,
  type PaneFunctionOptionDef,
  type PaneFunctionReadiness,
} from "./capabilities";
import {
  cliStyles,
  cliTerminalWidth,
  renderDefinitions,
  renderSection,
  renderStats,
  renderTable,
  wrapText,
  type CliStatEntry,
} from "../../utils/cli-output";

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

  for (const template of registry.paneTemplates.values()) {
    const pane = registry.panes.get(template.paneId);
    if (!pane) continue;
    const discovery = getHeadlessPaneDefinition(template, pane)?.discovery;
    registerResolverToken(lookup, discovery?.id, template);
    for (const alias of discovery?.aliases ?? []) registerResolverToken(lookup, alias, template);
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

  const headless = getHeadlessPaneDefinition(template, pane);
  return {
    token: template.shortcut?.prefix ?? template.id,
    label: template.label,
    description: template.description,
    paneId: pane.id,
    paneName: pane.name,
    templateId: template.id,
    shortcut: template.shortcut?.prefix,
    argKind: headless?.argument.kind ?? template.shortcut?.argKind,
    argPlaceholder: headless?.argument.placeholder ?? template.shortcut?.argPlaceholder,
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
      argKind: pane.headless?.argument.kind,
      argPlaceholder: pane.headless?.argument.placeholder,
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

const CATALOG_TEXT_WIDTH = 100;
const READINESS_LABELS: Record<PaneFunctionReadiness, string> = {
  ready: "ready",
  partial: "partial",
  "live-dom": "rendered",
  unsupported: "none",
};

function readinessCell(readiness: PaneFunctionReadiness): string {
  const label = READINESS_LABELS[readiness];
  if (readiness === "ready") return cliStyles.success(label);
  if (readiness === "partial") return cliStyles.warning(label);
  return cliStyles.muted(label);
}

function catalogArgument(entry: PaneCatalogEntry): string {
  if (entry.argPlaceholder) return `<${entry.argPlaceholder}>`;
  return entry.argKind && entry.argKind !== "none" ? `<${entry.argKind}>` : "";
}

// Choices longer than this move from the flag into its description, where they can wrap.
const MAX_INLINE_CHOICES = 24;

function optionChoices(option: PaneFunctionOptionDef): string[] {
  return option.values?.map(({ value }) => String(value)) ?? [];
}

function optionFlags(option: PaneFunctionOptionDef): string {
  const choices = optionChoices(option).join("|");
  return `--${option.key} <${choices && choices.length <= MAX_INLINE_CHOICES ? choices : option.values?.length ? "value" : option.type}>`;
}

function optionDescription(option: PaneFunctionOptionDef): string {
  const choices = optionChoices(option);
  const parts = [option.description.replace(/\.$/, "")];
  if (choices.join("|").length > MAX_INLINE_CHOICES) parts.push(`One of ${choices.join(", ")}`);
  if (option.defaultValue !== undefined && option.defaultValue !== "") parts.push(`Default ${String(option.defaultValue)}`);
  return `${parts.join(". ")}.`;
}

function renderCatalogEntry(entry: PaneCatalogEntry): string {
  const width = Math.min(cliTerminalWidth() ?? CATALOG_TEXT_WIDTH, CATALOG_TEXT_WIDTH);
  const capability = entry.capability;
  const argument = catalogArgument(entry);
  const invocation = `${entry.token}${argument ? ` ${argument}` : ""}`;
  const lines = [
    `${cliStyles.accent(entry.token)}  ${cliStyles.bold(entry.label)}`,
    ...wrapText(entry.description, width),
    "",
  ];
  const stats: CliStatEntry[] = [
    ["Argument", argument || cliStyles.muted("none")],
    ["Report", readinessCell(capability.reportReadiness)],
    ["Screenshot", readinessCell(capability.screenshotReadiness)],
    ["Bot safe", capability.botSafe ? "yes" : "no"],
    ["Pane", entry.paneId],
  ];
  if (capability.aliases.length > 0) stats.push(["Aliases", capability.aliases.join(", ")]);
  if (capability.dataRequirements.length > 0) stats.push(["Requires", capability.dataRequirements.join(", ")]);
  if (capability.limitations.length > 0) stats.push(["Limitations", capability.limitations.join(" ")]);
  lines.push(renderStats(stats));

  if (capability.options.length > 0) {
    lines.push("", renderSection("Options"));
    lines.push(...renderDefinitions(
      capability.options.map((option) => [optionFlags(option), optionDescription(option)] as const),
      { width, termStyle: cliStyles.command },
    ));
  }

  lines.push("", renderSection("Examples"));
  if (capability.reportReadiness !== "unsupported") lines.push(`  gloomberb fn ${invocation}`);
  lines.push(`  gloomberb shot ${invocation} --output ${entry.token.toLowerCase()}.png`);
  return lines.join("\n");
}

export function renderPaneCatalogReport(entries: PaneCatalogEntry[], args: ParsedPaneCatalogArgs): string {
  const exact = args.query
    ? entries.find((entry) => entry.token.toLowerCase() === args.query.trim().toLowerCase())
    : undefined;
  if (exact) return renderCatalogEntry(exact);
  if (args.query && entries.length === 1) return renderCatalogEntry(entries[0]!);

  const width = Math.min(cliTerminalWidth() ?? CATALOG_TEXT_WIDTH, CATALOG_TEXT_WIDTH);
  const note = (text: string) => wrapText(text, width).map((line) => cliStyles.muted(line)).join("\n");
  if (entries.length === 0) {
    return note(args.query
      ? `No functions match "${args.query}". Run gloomberb catalog to browse them all.`
      : "No functions are available.");
  }

  const shown = entries.slice(0, args.limit);
  const count = shown.length < entries.length ? `${shown.length} of ${entries.length}` : String(entries.length);
  const title = args.query ? `Matches for "${args.query}"` : "Functions";
  const lines = [
    `${renderSection(title)} ${cliStyles.muted(`(${count})`)}`,
    renderTable(
      [
        { header: "Function", shrink: false },
        { header: "Name", maxWidth: 20 },
        { header: "Argument", maxWidth: 14 },
        { header: "Report" },
        { header: "Description" },
      ],
      shown.map((entry) => [
        cliStyles.command(entry.token),
        entry.label,
        catalogArgument(entry),
        readinessCell(entry.capability.reportReadiness),
        entry.description,
      ]),
    ),
    "",
    note(shown.length < entries.length
      ? `gloomberb catalog <function> shows its options and examples. Add --all to list all ${entries.length}.`
      : "gloomberb catalog <function> shows its options and examples."),
  ];
  return lines.join("\n");
}
