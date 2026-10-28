import type { ScreenDefinition, ScreenPayload, ScreenRow } from "../../../api-client/equity-screener";

/**
 * The sector and industry names a screen's `sector` and `industry` criteria
 * match, as the screener's rows carry them (read from the covered universe on
 * 2026-10-28): the eleven sectors and the industries under them. A criterion
 * matches a name exactly, so `Utility` or `utilities` matches nothing.
 */
export const SCREEN_SECTORS = [
  "Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy",
  "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities",
] as const;

export const SCREEN_INDUSTRIES = [
  "Advertising Agencies", "Aerospace & Defense", "Agricultural Inputs", "Airlines", "Airports & Air Services",
  "Aluminum", "Apparel Manufacturing", "Apparel Retail", "Asset Management", "Auto Manufacturers", "Auto Parts",
  "Auto & Truck Dealerships", "Banks - Diversified", "Banks - Regional", "Beverages - Brewers",
  "Beverages - Non-Alcoholic", "Beverages - Wineries & Distilleries", "Biotechnology", "Broadcasting",
  "Building Materials", "Building Products & Equipment", "Business Equipment & Supplies", "Capital Markets",
  "Chemicals", "Coking Coal", "Communication Equipment", "Computer Hardware", "Confectioners", "Conglomerates",
  "Consulting Services", "Consumer Electronics", "Copper", "Credit Services", "Department Stores",
  "Diagnostics & Research", "Discount Stores", "Drug Manufacturers - General",
  "Drug Manufacturers - Specialty & Generic", "Education & Training Services", "Electrical Equipment & Parts",
  "Electronic Components", "Electronic Gaming & Multimedia", "Electronics & Computer Distribution",
  "Engineering & Construction", "Entertainment", "Farm & Heavy Construction Machinery", "Farm Products",
  "Financial Conglomerates", "Financial Data & Stock Exchanges", "Food Distribution", "Footwear & Accessories",
  "Furnishings, Fixtures & Appliances", "Gambling", "Gold", "Grocery Stores", "Healthcare Plans",
  "Health Information Services", "Home Improvement Retail", "Household & Personal Products",
  "Industrial Distribution", "Information Technology Services", "Infrastructure Operations", "Insurance Brokers",
  "Insurance - Diversified", "Insurance - Life", "Insurance - Property & Casualty", "Insurance - Reinsurance",
  "Insurance - Specialty", "Integrated Freight & Logistics", "Internet Content & Information", "Internet Retail",
  "Leisure", "Lodging", "Lumber & Wood Production", "Luxury Goods", "Marine Shipping", "Medical Care Facilities",
  "Medical Devices", "Medical Distribution", "Medical Instruments & Supplies", "Metal Fabrication",
  "Mortgage Finance", "Oil & Gas Drilling", "Oil & Gas E&P", "Oil & Gas Equipment & Services",
  "Oil & Gas Integrated", "Oil & Gas Midstream", "Oil & Gas Refining & Marketing",
  "Other Industrial Metals & Mining", "Other Precious Metals & Mining", "Packaged Foods",
  "Packaging & Containers", "Paper & Paper Products", "Personal Services", "Pharmaceutical Retailers",
  "Pollution & Treatment Controls", "Publishing", "Railroads", "Real Estate - Development",
  "Real Estate Services", "Recreational Vehicles", "REIT - Diversified", "REIT - Healthcare Facilities",
  "REIT - Hotel & Motel", "REIT - Industrial", "REIT - Mortgage", "REIT - Office", "REIT - Residential",
  "REIT - Retail", "REIT - Specialty", "Rental & Leasing Services", "Residential Construction",
  "Resorts & Casinos", "Restaurants", "Scientific & Technical Instruments", "Security & Protection Services",
  "Semiconductor Equipment & Materials", "Semiconductors", "Shell Companies", "Silver",
  "Software - Application", "Software - Infrastructure", "Solar", "Specialty Business Services",
  "Specialty Chemicals", "Specialty Industrial Machinery", "Specialty Retail", "Staffing & Employment Services",
  "Steel", "Telecom Services", "Textile Manufacturing", "Thermal Coal", "Tobacco", "Tools & Accessories",
  "Travel Services", "Trucking", "Uranium", "Utilities - Diversified", "Utilities - Independent Power Producers",
  "Utilities - Regulated Electric", "Utilities - Regulated Gas", "Utilities - Regulated Water",
  "Utilities - Renewable", "Waste Management",
] as const;

/** GICS sector names, which these sectors are not, as the sector each means. */
const GICS_SECTORS: Record<string, (typeof SCREEN_SECTORS)[number]> = {
  informationtechnology: "Technology",
  financials: "Financial Services",
  healthcare: "Healthcare",
  consumerstaples: "Consumer Defensive",
  consumerdiscretionary: "Consumer Cyclical",
  materials: "Basic Materials",
  telecommunicationservices: "Communication Services",
};

/** The category fields whose names a screen can be checked against. A symbol has no list to check. */
type NamedField = "sector" | "industry" | "exchange" | "currency";
const NAMED_FIELDS: readonly NamedField[] = ["sector", "industry", "exchange", "currency"];

/** A criterion's value that names nothing the screen covers, with the names it was likely meant as. */
interface UnmatchedCategoryValue {
  field: NamedField;
  value: string;
  closest: string[];
  /** The value is a name of the other of sector and industry: `Solar` given as a sector. */
  otherField?: "sector" | "industry";
}

/** Names compared without case, spaces or punctuation: `Oil and Gas E&P` beside `oil & gas e&p`. */
const fold = (name: string) => name.toLowerCase().replace(/\band\b/g, "&").replace(/[^a-z0-9&]+/g, "");

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** How far a typed name is from a candidate, 0 the same and 1 nothing alike: against the whole name or one of its parts. */
function nameDistance(typed: string, candidate: string): number {
  const needle = fold(typed);
  if (!needle) return 1;
  const parts = [candidate, ...candidate.split(/\s+-\s+|\s+/)].map(fold).filter(Boolean);
  return Math.min(...parts.map((part) => {
    if (part === needle) return 0;
    // "Bank" in "Banks - Regional", "Regulated" in "Utilities - Regulated Gas".
    if (needle.length >= 4 && part.startsWith(needle)) return 0.2;
    return editDistance(needle, part) / Math.max(needle.length, part.length);
  }));
}

/** Names further than this from what was typed are not offered. */
const CLOSEST_DISTANCE = 0.4;
const CLOSEST_LIMIT = 5;

/** The names a typed one was likely meant as, closest first. */
function closestCategoryNames(typed: string, names: Iterable<string>, limit = CLOSEST_LIMIT): string[] {
  const scored = [...new Set(names)].map((name) => ({ name, distance: nameDistance(typed, name) }));
  // The name typed in another case or spacing is the one meant, whatever else is near it.
  const same = scored.filter(({ name }) => fold(name) === fold(typed));
  return (same.length > 0 ? same : scored)
    .filter(({ distance }) => distance <= CLOSEST_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name);
}

/**
 * The names each category field matches: the sector and industry lists above
 * with those the rows carry, and the exchanges and currencies the covered
 * universe reports. A field with no list (an older server's universe) is left
 * out, so nothing is said of its values.
 */
function knownNames(payload: Pick<ScreenPayload, "universe">, rows: readonly Pick<ScreenRow, NamedField>[]): Record<NamedField, Set<string> | null> {
  const seen = (field: NamedField) => rows.flatMap((row) => row[field] ? [row[field]!] : []);
  const served = (list: readonly string[] | undefined, field: NamedField) =>
    list?.length ? new Set([...list, ...seen(field)]) : null;
  return {
    sector: new Set([...SCREEN_SECTORS, ...payload.universe.sectors ?? [], ...seen("sector")]),
    industry: new Set([...SCREEN_INDUSTRIES, ...seen("industry")]),
    exchange: served(payload.universe.exchanges, "exchange"),
    currency: served(payload.universe.currencies, "currency"),
  };
}

/**
 * The values of a screen's category criteria that name nothing the screen
 * covers (`Utility` for the Utilities sector), so the screen reads why it
 * matched nothing, or less than it should, rather than "No data".
 */
export function unmatchedCategoryValues(
  definition: ScreenDefinition,
  payload: Pick<ScreenPayload, "universe">,
  rows: readonly Pick<ScreenRow, NamedField>[] = [],
): UnmatchedCategoryValue[] {
  const known = knownNames(payload, rows);
  const unmatched: UnmatchedCategoryValue[] = [];
  for (const criterion of definition.criteria) {
    if (criterion.op !== "in" || !(NAMED_FIELDS as readonly string[]).includes(criterion.field)) continue;
    const field = criterion.field as NamedField;
    const names = known[field];
    if (!names) continue;
    for (const value of criterion.value) {
      if (names.has(value)) continue;
      const other = field === "sector" ? "industry" : field === "industry" ? "sector" : null;
      const otherNames = other ? known[other] : null;
      const otherField = other && otherNames && [...otherNames].some((name) => fold(name) === fold(value)) ? other : undefined;
      const gics = field === "sector" ? GICS_SECTORS[fold(value)] : undefined;
      const closest = gics ? [gics] : closestCategoryNames(value, names);
      unmatched.push({ field, value, closest, ...(otherField ? { otherField } : {}) });
    }
  }
  return unmatched;
}

const quoted = (value: string) => JSON.stringify(value);

/** What a screen says of a value that names nothing: `No sector is named "Utility". Closest: Utilities.` */
export function unmatchedCategoryText(entry: UnmatchedCategoryValue): string {
  const head = `No ${entry.field} is named ${quoted(entry.value)}`;
  if (entry.otherField) return `${head}; it is ${entry.otherField === "industry" ? "an industry" : "a sector"} name, so use "field": ${quoted(entry.otherField)}.`;
  return entry.closest.length > 0 ? `${head}. Closest: ${entry.closest.join(", ")}.` : `${head}.`;
}

/** Where every sector and industry name is listed, said once after the values that name nothing. */
export const CATEGORY_NAMES_POINTER = "gloom catalog EQS lists every sector and industry.";
