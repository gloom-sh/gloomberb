/**
 * One company as TheBuildout sees it: who powers and hosts it, who supplies
 * it, who pays it, where its sites are and where it hires. Read from the
 * dataset's company profile with the account's own access, so the free tier
 * gets what the dataset gives it and a Pro account the rest.
 */
import { buildoutApi, getBuildoutProToken } from "../model";
import { normalizeUpdate } from "../model/normalizers";
import type { BuildoutUpdate, RawObject } from "../model/types";
import { metricNumber, tickerSymbol } from "../format";

export type RelationRole = "power" | "supplier" | "customer" | "competitor";

export interface BuildoutRelation {
  id: string;
  name: string;
  ticker: string | null;
  role: RelationRole;
  /** The deal in a few words: "800 MW · 15 yr", "67% of FY2025 revenue". */
  figure: string | null;
  /** What the relationship is, in the dataset's words. */
  summary: string | null;
  /** MW for a power deal, dollars for the rest, to order and total them. */
  weight: number | null;
}

export interface BuildoutCompanySite {
  id: string;
  name: string;
  type: string | null;
  /** Owner, or partner for a site the company is named at but does not own. */
  role: "owner" | "partner";
  mw: number | null;
  place: string | null;
}

export interface BuildoutHiringSegment {
  id: string;
  place: string;
  roleFamily: string | null;
  roles: number | null;
  change: number | null;
  site: string | null;
}

export interface BuildoutCompanyProfile {
  id: string;
  name: string;
  ticker: string | null;
  marketCap: string | null;
  return1y: string | null;
  growth: string | null;
  relations: BuildoutRelation[];
  sites: BuildoutCompanySite[];
  hiring: {
    /** The dataset has hiring by site for this company, whether this account sees it or not. */
    hasData: boolean;
    segments: BuildoutHiringSegment[];
    openRoles: number | null;
  };
  access: "free" | "pro";
}

const POWER_PATTERN = /power|energy|colocation|hosting|data_center_capacity|capacity_supply/i;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const list = (value: unknown): RawObject[] => (Array.isArray(value) ? value.filter((item): item is RawObject => !!item && typeof item === "object") : []);

/** "data_center_onsite_power" reads "Data center onsite power". */
function words(value: string | null): string | null {
  const text = value?.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const cased = text.replace(/\b(ai|hpc|gpu|cpu)\b/gi, (word) => word.toUpperCase());
  return cased.charAt(0).toUpperCase() + cased.slice(1);
}

function dollars(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(value >= 1e11 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (value >= 1e6) return `$${Math.round(value / 1e6)}M`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The largest MW figure a text gives, as written: "approximately 590 MW". */
function largestMegawatts(text: string | null): number | null {
  let best: number | null = null;
  for (const match of text?.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(GW|MW)\b/g) ?? []) {
    const value = Number(match[1]!.replace(/,/g, "")) * (match[2] === "GW" ? 1000 : 1);
    if (Number.isFinite(value) && (best === null || value > best)) best = value;
  }
  return best;
}

/** "$14.2 billion through December 2031" reads "$14.2B through Dec 2031". */
function contractFigure(text: string | null): string | null {
  const money = text?.match(/\$\s?(\d+(?:\.\d+)?)\s*(billion|million|bn|B|M)\b/i);
  if (!money) return null;
  const unit = /^(b|bn|billion)$/i.test(money[2]!) ? "B" : "M";
  const until = text!.slice(money.index!).match(/through\s+([A-Z][a-z]+)\s+(\d{4})/);
  const month = until && MONTHS.includes(until[1]!) ? until[1]!.slice(0, 3) : null;
  return `$${money[1]}${unit}${month ? ` through ${month} ${until![2]}` : ""}`;
}

/** "approximately 67% of FY2025 revenue". */
function revenueShare(text: string | null): string | null {
  const match = text?.match(/(\d+(?:\.\d+)?)%\s+of\s+(?:its\s+)?((?:FY|fiscal\s+)?\d{4}\s+)?(?:total\s+)?revenue/i);
  return match ? `${match[1]}% of ${match[2]?.trim() ? `${match[2].trim()} ` : ""}revenue` : null;
}

function term(text: string | null): string | null {
  const match = text?.match(/(\d+)-year/);
  return match ? `${match[1]} yr` : null;
}

function relation(raw: RawObject, role: RelationRole): BuildoutRelation | null {
  const name = str(raw.name);
  if (!name) return null;
  const description = str(raw.description);
  const evidence = str(raw.evidenceSummary);
  const usd = num(raw.weightUsd);
  const category = str(raw.flowCategory) ?? str(raw.relationshipScope);
  let figure: string | null = null;
  let weight: number | null = usd;
  if (role === "power") {
    const mw = largestMegawatts(description) ?? largestMegawatts(evidence);
    weight = mw;
    const parts = [mw ? `${mw.toLocaleString("en-US")} MW` : null, usd ? dollars(usd) : null, term(str(raw.weightPeriod))].filter(Boolean);
    figure = parts.length ? parts.join(" · ") : words(category);
  } else if (role === "customer") {
    figure = revenueShare(evidence) ?? revenueShare(description) ?? contractFigure(evidence) ?? contractFigure(description)
      ?? (usd ? dollars(usd) : null) ?? words(category);
  } else if (role === "supplier") {
    figure = words(category);
  }
  return {
    id: str(raw.companyId) ?? str(raw.id) ?? name,
    name,
    ticker: tickerSymbol(str(raw.ticker)),
    role,
    figure,
    summary: description ?? evidence,
    weight,
  };
}

/** One card per company and role: the dataset can list a supplier once per thing it supplies. */
function unique(relations: (BuildoutRelation | null)[]): BuildoutRelation[] {
  const seen = new Map<string, BuildoutRelation>();
  for (const entry of relations) {
    if (!entry) continue;
    const key = `${entry.role}:${entry.id}`;
    const existing = seen.get(key);
    if (!existing || (existing.weight === null && entry.weight !== null)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function byWeight(left: BuildoutRelation, right: BuildoutRelation) {
  return (right.weight ?? -1) - (left.weight ?? -1);
}

function site(raw: RawObject): BuildoutCompanySite | null {
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const capacity = str(raw.powerCapacity);
  const location = raw.location && typeof raw.location === "object" ? raw.location as RawObject : {};
  const mw = capacity ? largestMegawatts(capacity.replace(/(\d)(MW|GW)/, "$1 $2")) : null;
  return {
    id,
    name,
    type: str(raw.type),
    role: str(raw.relationship) === "owner" ? "owner" : "partner",
    mw: mw && mw > 0 ? mw : null,
    place: [str(location.city), str(location.country)].filter(Boolean).join(", ") || null,
  };
}

function hiringSegment(raw: RawObject): BuildoutHiringSegment | null {
  const id = str(raw.id);
  if (!id) return null;
  const place = [str(raw.city), str(raw.region) ?? str(raw.countryIso)].filter(Boolean).join(", ") || str(raw.locationRaw) || "Unplaced";
  const siteRecord = raw.site && typeof raw.site === "object" ? raw.site as RawObject : null;
  return {
    id,
    place,
    roleFamily: words(str(raw.roleFamily)),
    roles: num(raw.latestRoleCountEstimate),
    change: num(raw.deltaSincePriorPeriod) ?? num(raw.deltaSincePriorObservation),
    site: siteRecord ? str(siteRecord.name) : null,
  };
}

export function normalizeCompanyProfile(raw: RawObject, access: "free" | "pro"): BuildoutCompanyProfile {
  const chain = raw.supplyChain && typeof raw.supplyChain === "object" ? raw.supplyChain as RawObject : {};
  const suppliers = list(chain.suppliers);
  const relations = [
    ...unique(suppliers.filter((entry) => POWER_PATTERN.test(`${str(entry.flowCategory) ?? ""} ${str(entry.relationshipScope) ?? ""}`)).map((entry) => relation(entry, "power"))).sort(byWeight),
    ...unique(suppliers.filter((entry) => !POWER_PATTERN.test(`${str(entry.flowCategory) ?? ""} ${str(entry.relationshipScope) ?? ""}`)).map((entry) => relation(entry, "supplier"))),
    ...unique(list(chain.customers).map((entry) => relation(entry, "customer"))).sort(byWeight),
    ...unique(list(chain.competitors).map((entry) => relation(entry, "competitor"))),
  ];
  const hiring = raw.hiring && typeof raw.hiring === "object" ? raw.hiring as RawObject : {};
  return {
    id: str(raw.id) ?? "",
    name: str(raw.name) ?? "",
    ticker: tickerSymbol(str(raw.ticker)),
    marketCap: str(raw.marketCap),
    return1y: str(raw.return1y),
    growth: str(raw.revenueGrowthYoy),
    relations,
    sites: list(raw.sites).map(site).filter((entry): entry is BuildoutCompanySite => !!entry)
      .sort((left, right) => Number(left.role !== "owner") - Number(right.role !== "owner") || (right.mw ?? -1) - (left.mw ?? -1)),
    hiring: {
      hasData: hiring.hasData === true,
      segments: list(hiring.segments).map(hiringSegment).filter((entry): entry is BuildoutHiringSegment => !!entry),
      openRoles: num(hiring.totalOpenRolesEstimate) ?? metricNumber(raw.recruitment_open_roles ?? raw.recruitmentOpenRoles),
    },
    access,
  };
}

/** The company under `symbol`, or null when the dataset has none. */
export async function fetchCompanyProfile(symbol: string): Promise<BuildoutCompanyProfile | null> {
  const token = await getBuildoutProToken();
  try {
    const raw = await buildoutApi<RawObject>(`/companies/${encodeURIComponent(symbol)}`, token);
    return normalizeCompanyProfile(raw, token ? "pro" : "free");
  } catch (error) {
    if (error instanceof Error && /not found|404/i.test(error.message)) return null;
    throw error;
  }
}

export async function fetchCompanySignals(companyId: string): Promise<BuildoutUpdate[]> {
  const token = await getBuildoutProToken();
  const raw = await buildoutApi<RawObject[]>(`/updates?companyId=${encodeURIComponent(companyId)}&limit=40`, token);
  return Array.isArray(raw) ? raw.map(normalizeUpdate) : [];
}

/** Power deals in MW, summed: what the header's power figure says. */
export function totalPowerMw(profile: BuildoutCompanyProfile): number | null {
  const figures = profile.relations.filter((entry) => entry.role === "power" && entry.weight !== null).map((entry) => entry.weight!);
  return figures.length ? figures.reduce((sum, value) => sum + value, 0) : null;
}
