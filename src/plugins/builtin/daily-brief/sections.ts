import { parseViewSpecOr, type ViewSpec } from "../custom-view/view-spec";
import { isRecord } from "../../../utils/guards";
import { rankedBriefBuiltins, type BriefProfile } from "./profile";

/** Plugin setting that holds the small-table list. Ask Gloom writes the same JSON. */
export const BRIEF_SECTIONS_SETTING = "sections";

const BRIEF_BUILTINS = ["headlines", "today", "earnings"] as const;
type BriefBuiltin = (typeof BRIEF_BUILTINS)[number];

/** A brief is a short stack. Past this, it stops being a brief. */
const BRIEF_SECTION_CAP = 8;
/** A table with no limit of its own shows this many rows. */
const BRIEF_TABLE_DEFAULT = 8;
/** Projection limits above this are cut down so an added view stays a small table. */
const BRIEF_TABLE_CAP = 12;

const BUILTIN_TITLE: Record<BriefBuiltin, string> = {
  headlines: "Headlines",
  today: "Today",
  earnings: "Earnings",
};

export interface BriefBuiltinSection {
  kind: "builtin";
  id: string;
  builtin: BriefBuiltin;
  title?: string;
}

export interface BriefViewSection {
  kind: "view";
  id: string;
  title: string;
  spec: ViewSpec;
}

export type BriefSection = BriefBuiltinSection | BriefViewSection;

export interface BriefLayout {
  version: 1;
  sections: BriefSection[];
}

export function defaultBriefLayout(profile?: BriefProfile): BriefLayout {
  const builtins = profile ? rankedBriefBuiltins(profile) : [...BRIEF_BUILTINS];
  return {
    version: 1,
    sections: builtins.map((builtin) => ({ kind: "builtin", id: builtin, builtin })),
  };
}

export function serializeBriefLayout(layout: BriefLayout): string {
  return JSON.stringify({
    version: 1,
    sections: layout.sections.map((section) => (
      section.kind === "builtin"
        ? { id: section.id, builtin: section.builtin, ...(section.title ? { title: section.title } : {}) }
        : { id: section.id, title: section.title, spec: section.spec }
    )),
  });
}

export function briefSectionTitle(section: BriefSection): string {
  if (section.kind === "builtin") return section.title ?? BUILTIN_TITLE[section.builtin];
  return section.title;
}

const BUILTIN_DETAIL: Record<BriefBuiltin, string> = {
  headlines: "News",
  today: "Releases today",
  earnings: "Companies reporting",
};

/** Blank or broken storage is the default brief. An explicit empty list stays empty. */
export function resolveBriefLayout(stored: unknown): BriefLayout {
  const parsed = parseBriefSections(stored ?? "");
  return "layout" in parsed ? parsed.layout : defaultBriefLayout();
}

/** Ids the Tables checklist shows as checked, in table order. */
export function presentBriefTables(stored: unknown): string[] {
  return resolveBriefLayout(stored).sections.map((section) => section.id);
}

/**
 * Checklist rows: the tables already on the brief, then any built-in table
 * that was turned off so it can be turned back on.
 */
export function briefTableChoices(layout: BriefLayout): Array<{ value: string; label: string; description: string }> {
  const used = new Set(layout.sections.map((section) => section.id));
  const have = new Set(layout.sections.flatMap((section) => section.kind === "builtin" ? [section.builtin] : []));
  const choices = layout.sections.map((section) => ({
    value: section.id,
    label: briefSectionTitle(section),
    description: section.kind === "view" ? "View" : BUILTIN_DETAIL[section.builtin],
  }));
  for (const builtin of BRIEF_BUILTINS) {
    if (have.has(builtin)) continue;
    choices.push({
      value: cleanId(undefined, builtin, used),
      label: BUILTIN_TITLE[builtin],
      description: BUILTIN_DETAIL[builtin],
    });
  }
  return choices;
}

function builtinForChoiceId(id: string): BriefBuiltin | null {
  for (const builtin of BRIEF_BUILTINS) {
    if (id === builtin) return builtin;
    const rest = id.slice(builtin.length + 1);
    if (id.startsWith(`${builtin}-`) && /^\d+$/.test(rest)) return builtin;
  }
  return null;
}

/**
 * The checklist edits ids. A full sections document, the shape `brief.update`
 * writes, is stored as itself. Ids keep the view spec on a table that stays.
 */
export function storeBriefTables(edited: unknown, stored: unknown): string {
  if (edited == null || edited === "") return serializeBriefLayout(defaultBriefLayout());
  if (typeof edited === "string" || (isRecord(edited) && !Array.isArray(edited))) {
    const parsed = parseBriefSections(edited);
    if ("error" in parsed) throw new Error(parsed.error);
    return serializeBriefLayout(parsed.layout);
  }
  if (!Array.isArray(edited)) throw new Error("Tables need a list.");
  if (edited.some((entry) => typeof entry !== "string")) {
    const parsed = parseBriefSections(edited);
    if ("error" in parsed) throw new Error(parsed.error);
    return serializeBriefLayout(parsed.layout);
  }
  const ids = edited.filter((entry): entry is string => typeof entry === "string");
  if (ids.length > BRIEF_SECTION_CAP) {
    throw new Error(`A brief holds at most ${BRIEF_SECTION_CAP} tables.`);
  }
  const byId = new Map(resolveBriefLayout(stored).sections.map((section) => [section.id, section]));
  const sections: BriefSection[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const existing = byId.get(id);
    if (existing) {
      sections.push(existing);
      continue;
    }
    const builtin = builtinForChoiceId(id);
    if (!builtin) throw new Error(`Unknown table "${id}".`);
    sections.push({ kind: "builtin", id, builtin });
  }
  return serializeBriefLayout({ version: 1, sections });
}

/** Keep an added worksheet short enough to sit under the session chart. */
export function capBriefView(spec: ViewSpec): ViewSpec {
  const requested = spec.projection.limit ?? BRIEF_TABLE_DEFAULT;
  const limit = Math.min(Math.max(1, Math.floor(requested)), BRIEF_TABLE_CAP);
  if (limit === spec.projection.limit) return spec;
  return { ...spec, projection: { ...spec.projection, limit } };
}

function builtinName(value: unknown): BriefBuiltin | null {
  return typeof value === "string" && (BRIEF_BUILTINS as readonly string[]).includes(value)
    ? value as BriefBuiltin
    : null;
}

function cleanId(value: unknown, fallback: string, used: Set<string>): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) : "";
  const base = raw || fallback;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function sectionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  return title ? title.slice(0, 80) : undefined;
}

/**
 * A blank setting is the default brief. A JSON object `{ sections }` or a
 * bare array is the user's list. Each entry is `headlines` / `today` /
 * `earnings`, or a view spec in the same shape `view.create` accepts.
 */
export function parseBriefSections(value: unknown): { layout: BriefLayout } | { error: string } {
  if (value == null || value === "") return { layout: defaultBriefLayout() };
  let decoded: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { layout: defaultBriefLayout() };
    try {
      decoded = JSON.parse(trimmed);
    } catch (error) {
      return { error: `Tables are not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (decoded == null) return { layout: defaultBriefLayout() };
  if (Array.isArray(decoded)) return sectionsFrom(decoded);
  if (!isRecord(decoded)) return { error: "Tables need a sections list." };
  if (decoded.version != null && decoded.version !== 1) return { error: "Unknown tables version." };
  if (!Array.isArray(decoded.sections)) return { error: "Tables need a sections list." };
  return sectionsFrom(decoded.sections);
}

function sectionsFrom(entries: readonly unknown[]): { layout: BriefLayout } | { error: string } {
  if (entries.length > BRIEF_SECTION_CAP) {
    return { error: `A brief holds at most ${BRIEF_SECTION_CAP} tables.` };
  }
  const used = new Set<string>();
  const sections: BriefSection[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsed = oneSection(entries[index], index, used);
    if ("error" in parsed) return parsed;
    sections.push(parsed.section);
  }
  return { layout: { version: 1, sections } };
}

function oneSection(entry: unknown, index: number, used: Set<string>): { section: BriefSection } | { error: string } {
  const where = `sections.${index}`;
  const named = builtinName(entry);
  if (named) {
    return { section: { kind: "builtin", id: cleanId(undefined, named, used), builtin: named } };
  }
  if (!isRecord(entry)) return { error: `${where}: a table is headlines, today, earnings, or a view.` };
  const builtin = builtinName(entry.builtin);
  if (builtin) {
    if ("spec" in entry || "source" in entry) return { error: `${where}: a builtin table does not also take a view.` };
    const title = sectionTitle(entry.title);
    return { section: { kind: "builtin", id: cleanId(entry.id, builtin, used), builtin, ...(title ? { title } : {}) } };
  }
  if (entry.builtin != null) return { error: `${where}: unknown table "${String(entry.builtin)}".` };
  const specValue = "spec" in entry ? entry.spec : "source" in entry ? entry : null;
  if (specValue == null) return { error: `${where}: a table is headlines, today, earnings, or a view.` };
  const parsed = parseViewSpecOr(specValue);
  if ("error" in parsed) return { error: `${where}: ${parsed.error}` };
  const title = sectionTitle(entry.title) ?? parsed.spec.presentation.title ?? "Table";
  return {
    section: {
      kind: "view",
      id: cleanId(entry.id, title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "view", used),
      title,
      spec: capBriefView(parsed.spec),
    },
  };
}
