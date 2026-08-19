
export interface SectorDef {
  name: string;
  etf: string;
}

export type SectorCollectionId = "sectors" | "industries";

export interface SectorCollection {
  id: SectorCollectionId;
  label: string;
  items: SectorDef[];
}

const CORE_SECTORS: SectorDef[] = [
  { name: "Technology",       etf: "XLK" },
  { name: "Healthcare",       etf: "XLV" },
  { name: "Financials",       etf: "XLF" },
  { name: "Consumer Disc.",   etf: "XLY" },
  { name: "Communication",    etf: "XLC" },
  { name: "Industrials",      etf: "XLI" },
  { name: "Consumer Staples", etf: "XLP" },
  { name: "Energy",           etf: "XLE" },
  { name: "Utilities",        etf: "XLU" },
  { name: "Real Estate",      etf: "XLRE" },
  { name: "Materials",        etf: "XLB" },
];

const INDUSTRIES: SectorDef[] = [
  { name: "Semiconductors",   etf: "SMH" },
  { name: "Software",         etf: "IGV" },
  { name: "Cybersecurity",    etf: "CIBR" },
  { name: "Aero/Defense",     etf: "ITA" },
  { name: "Banks",            etf: "KBE" },
  { name: "Regional Banks",   etf: "KRE" },
  { name: "Biotech",          etf: "XBI" },
  { name: "Pharma",           etf: "PPH" },
  { name: "Homebuilders",     etf: "XHB" },
  { name: "Retail",           etf: "XRT" },
  { name: "Food & Bev.",      etf: "PBJ" },
  { name: "Leisure",          etf: "PEJ" },
  { name: "Transportation",   etf: "IYT" },
  { name: "Metals/Mining",    etf: "XME" },
  { name: "Oil & Gas E&P",    etf: "XOP" },
  { name: "Clean Energy",     etf: "ICLN" },
  { name: "Infrastructure",   etf: "PAVE" },
  { name: "Gold Miners",      etf: "GDX" },
];

export const SECTOR_COLLECTIONS: SectorCollection[] = [
  { id: "sectors", label: "Sectors", items: CORE_SECTORS },
  { id: "industries", label: "Industries", items: INDUSTRIES },
];

export function getSectorCollection(id: SectorCollectionId): SectorCollection {
  return SECTOR_COLLECTIONS.find((collection) => collection.id === id) ?? SECTOR_COLLECTIONS[0]!;
}

/** Settings key holding the saved ETF selection for a collection. */
export function collectionSettingKey(id: SectorCollectionId): string {
  return id === "industries" ? "industryEtfs" : "sectorEtfs";
}

/** The saved ETF selection, falling back to the full list when it is unusable. */
export function resolveCollectionItems(
  id: SectorCollectionId,
  saved?: readonly string[],
): SectorDef[] {
  const all = getSectorCollection(id).items;
  const byEtf = new Map(all.map((item) => [item.etf, item]));
  const resolved = (saved ?? [])
    .map((etf) => byEtf.get(etf))
    .filter((item): item is SectorDef => !!item);
  return resolved.length > 0 ? resolved : [...all];
}
