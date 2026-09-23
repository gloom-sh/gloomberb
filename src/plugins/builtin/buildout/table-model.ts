import type {
  BuildoutColumn,
  BuildoutColumnId,
  BuildoutCompany,
  BuildoutList,
  BuildoutLoadState,
  BuildoutRow,
  BuildoutTabId,
  SortComparable,
  SortDirection,
} from "./model/types";
import { metricNumber, textOrNull, tickerSymbol } from "./format";

export const tabs: Array<{ label: string; value: BuildoutTabId }> = [
  { label: "Companies", value: "companies" },
  { label: "Sites", value: "sites" },
  { label: "Intel", value: "intel" },
];

const listColumns: BuildoutColumn[] = [
  { id: "listName", label: "List Name", width: 30, align: "left", flexGrow: 2 },
  { id: "listDescription", label: "Description", width: 34, align: "left", flexGrow: 3 },
  { id: "companyCount", label: "Companies", width: 10, align: "right" },
  { id: "totalMarketCap", label: "Market Cap", width: 12, align: "right" },
  { id: "avgSectorGrowth", label: "Med Growth", width: 11, align: "right" },
  { id: "avgReturn1y", label: "Med 1Y Rtn", width: 11, align: "right" },
  { id: "avgMargin", label: "Med Margin", width: 10, align: "right" },
];

const favoriteColumn: BuildoutColumn = { id: "favorite", label: "", width: 2, align: "left" };

const companyColumns: BuildoutColumn[] = [
  { id: "company", label: "Company", width: 26, align: "left", flexGrow: 2 },
  { id: "description", label: "Description", width: 34, align: "left", flexGrow: 2 },
  { id: "sectorTech", label: "Sector & Tech", width: 26, align: "left", flexGrow: 1 },
  { id: "criticality", label: "Criticality", width: 12, align: "left" },
  { id: "marketCap", label: "Mkt Cap", width: 10, align: "right" },
  { id: "revenue", label: "Revenue", width: 10, align: "right" },
  { id: "revenueGrowth", label: "Rev Grw", width: 9, align: "right" },
  { id: "netIncome", label: "Net Inc", width: 10, align: "right" },
  { id: "margin", label: "Margin", width: 8, align: "right" },
  { id: "forwardPE", label: "Fwd P/E", width: 8, align: "right" },
  { id: "dividendYield", label: "Div Yld", width: 8, align: "right" },
  { id: "return1y", label: "1Y Rtn", width: 8, align: "right" },
  { id: "employees", label: "Employees", width: 9, align: "right" },
];

const siteColumns: BuildoutColumn[] = [
  { id: "site", label: "Site Name", width: 28, align: "left", flexGrow: 2 },
  // The default sort, so it sits where it is always on screen.
  { id: "capture", label: "Last Sat", width: 10, align: "left" },
  { id: "type", label: "Type", width: 14, align: "left" },
  { id: "owner", label: "Owner", width: 12, align: "left", flexGrow: 1 },
  { id: "location", label: "Location", width: 16, align: "left", flexGrow: 1 },
  { id: "park", label: "Park", width: 14, align: "left", flexGrow: 1 },
  { id: "power", label: "Power/Cap", width: 12, align: "right" },
  { id: "construction", label: "Construction", width: 12, align: "right" },
  { id: "parking", label: "Parking", width: 9, align: "right" },
  { id: "area", label: "Area", width: 9, align: "right" },
];

const intelColumns: BuildoutColumn[] = [
  { id: "time", label: "Time", width: 4, align: "left" },
  { id: "companies", label: "Companies", width: 24, align: "left" },
  { id: "headline", label: "Title", width: 64, align: "left", flexGrow: 4 },
];

export function rowKey(row: BuildoutRow) {
  switch (row.kind) {
    case "list":
      return `list:${row.item.slug}`;
    case "company":
      return `company:${row.item.id}`;
    case "site":
      return `site:${row.item.id}`;
    case "intel":
      return `intel:${row.item.id}`;
  }
}

export function rowTitle(row: BuildoutRow) {
  switch (row.kind) {
    case "list":
      return row.item.name;
    case "company":
      return row.item.ticker ? `${row.item.name} (${row.item.ticker})` : row.item.name;
    case "site":
      return row.item.name;
    case "intel":
      return row.item.headline;
  }
}

function companyFavoriteIdentifier(company: BuildoutCompany) {
  const ticker = tickerSymbol(company.ticker);
  if (!ticker) return company.id;
  const exchange = textOrNull(company.exchange);
  return exchange ? `${exchange}:${ticker}` : ticker;
}

export function favoriteKey(row: BuildoutRow) {
  if (row.kind === "company" || row.kind === "site") return rowKey(row);
  return null;
}

export function rowStarred(row: BuildoutRow) {
  if (row.kind === "company" || row.kind === "site") return row.item.starred === true;
  return false;
}

export function rowWithFavorite(row: BuildoutRow, starred: boolean): BuildoutRow {
  if (row.kind === "company") return { ...row, item: { ...row.item, starred } };
  if (row.kind === "site") return { ...row, item: { ...row.item, starred } };
  return row;
}

export function favoriteApiPath(row: BuildoutRow) {
  if (row.kind === "company") {
    return `/starred/companies/${encodeURIComponent(companyFavoriteIdentifier(row.item))}`;
  }
  if (row.kind === "site") {
    return `/starred/sites/${encodeURIComponent(row.item.id)}`;
  }
  return null;
}

export function applyFavoriteToState(state: BuildoutLoadState, key: string, starred: boolean): BuildoutLoadState {
  if (state.status !== "ready") return state;
  if (key.startsWith("company:")) {
    const companyId = key.slice("company:".length);
    return {
      ...state,
      companies: {
        ...state.companies,
        items: state.companies.items.map((company) => (
          company.id === companyId ? { ...company, starred } : company
        )),
      },
    };
  }
  if (key.startsWith("site:")) {
    const siteId = key.slice("site:".length);
    return {
      ...state,
      sites: {
        ...state.sites,
        items: state.sites.items.map((site) => (
          site.id === siteId ? { ...site, starred } : site
        )),
      },
    };
  }
  return state;
}

export function activeRows(
  state: BuildoutLoadState,
  activeTab: BuildoutTabId,
  selectedList: BuildoutList | null,
): BuildoutRow[] {
  if (state.status !== "ready") return [];
  if (activeTab === "companies") {
    if (!selectedList) {
      return state.lists.map((item) => ({ kind: "list", item }));
    }
    return state.companies.items.map((item) => ({ kind: "company", item }));
  }
  if (activeTab === "sites") {
    return state.sites.items.map((item) => ({ kind: "site", item }));
  }
  return state.intel.items.map((item) => ({ kind: "intel", item }));
}

export function columnsForTab(activeTab: BuildoutTabId, selectedList: BuildoutList | null, canFavorite: boolean) {
  if (activeTab === "companies") {
    return selectedList && canFavorite ? [favoriteColumn, ...companyColumns] : selectedList ? companyColumns : listColumns;
  }
  if (activeTab === "sites") return canFavorite ? [favoriteColumn, ...siteColumns] : siteColumns;
  return intelColumns;
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, "en-US", { sensitivity: "base" });
}

function compareValues(left: SortComparable, right: SortComparable, direction: SortDirection) {
  if (left.type === "missing" && right.type === "missing") return 0;
  if (left.type === "missing") return 1;
  if (right.type === "missing") return -1;

  const result = left.type === "number" && right.type === "number"
    ? left.value - right.value
    : compareText(String(left.value), String(right.value));
  return direction === "asc" ? result : -result;
}

function numberSort(value: unknown): SortComparable {
  const numberValue = metricNumber(value);
  return numberValue == null ? { type: "missing" } : { type: "number", value: numberValue };
}

function dateSort(value: unknown): SortComparable {
  const stringValue = textOrNull(value);
  if (!stringValue) return { type: "missing" };
  const parsed = Date.parse(stringValue);
  return Number.isFinite(parsed) ? { type: "number", value: parsed } : { type: "missing" };
}

function stringSort(value: unknown): SortComparable {
  const stringValue = textOrNull(value);
  return stringValue == null ? { type: "missing" } : { type: "string", value: stringValue };
}

function sortValue(row: BuildoutRow, columnId: BuildoutColumnId): SortComparable {
  if (row.kind === "list") {
    const list = row.item;
    switch (columnId) {
      case "listName":
        return stringSort(list.name);
      case "listDescription":
        return stringSort(list.shortDescription ?? list.description);
      case "companyCount":
        return numberSort(list.companyCount);
      case "totalMarketCap":
        return numberSort(list.totalMarketCap);
      case "avgSectorGrowth":
        return numberSort(list.avgSectorGrowth);
      case "avgReturn1y":
        return numberSort(list.avgReturn1y);
      case "avgMargin":
        return numberSort(list.avgMargin);
      default:
        return stringSort(rowTitle(row));
    }
  }

  if (row.kind === "company") {
    const company = row.item;
    switch (columnId) {
      case "favorite":
        return numberSort(company.starred ? 1 : 0);
      case "company":
        return stringSort(company.name);
      case "description":
        return stringSort(company.description);
      case "sectorTech":
        return stringSort(company.primarySector ?? company.primaryTechnology);
      case "criticality":
        return stringSort(company.aiCriticality);
      case "marketCap":
        return numberSort(company.marketCap);
      case "revenue":
        return numberSort(company.revenue);
      case "revenueGrowth":
        return numberSort(company.revenueGrowthYoy ?? company.lastQuarterGrowth);
      case "netIncome":
        return numberSort(company.netIncome);
      case "margin":
        return numberSort(company.profitMargins);
      case "forwardPE":
        return numberSort(company.forwardPE);
      case "dividendYield":
        return numberSort(company.dividendYield);
      case "return1y":
        return numberSort(company.return1y);
      case "employees":
        return numberSort(company.employeeCount);
      default:
        return stringSort(rowTitle(row));
    }
  }

  if (row.kind === "site") {
    const site = row.item;
    const location = [site.location?.city, site.location?.country].filter(Boolean).join(", ");
    switch (columnId) {
      case "favorite":
        return numberSort(site.starred ? 1 : 0);
      case "site":
        return stringSort(site.name);
      case "type":
        return stringSort(site.type);
      case "owner":
        return stringSort(site.ownerTicker ?? site.ownerName);
      case "location":
        return stringSort(location);
      case "park":
        return stringSort(site.parkName);
      case "power":
        return numberSort(site.powerCapacity);
      case "construction":
        return numberSort(site.constructionActivity);
      case "parking":
        return numberSort(site.parkingActivity);
      case "capture":
        return dateSort(site.latestCapture);
      case "area":
        return numberSort(site.areaKm2);
      default:
        return stringSort(rowTitle(row));
    }
  }

  const update = row.item;
  switch (columnId) {
    case "time":
      return dateSort(update.publishedAt);
    case "companies":
      return stringSort(update.companies?.map((company) => company.ticker || company.name).filter(Boolean).join(", "));
    case "headline":
      return stringSort(update.headline);
    default:
      return stringSort(rowTitle(row));
  }
}

export function sortRows(rows: BuildoutRow[], columnId: BuildoutColumnId | null, direction: SortDirection) {
  if (!columnId) return rows;
  return [...rows].sort((left, right) => compareValues(
    sortValue(left, columnId),
    sortValue(right, columnId),
    direction,
  ));
}

export function defaultSortDirection(columnId: BuildoutColumnId | null): SortDirection {
  if (!columnId) return "asc";
  return [
    "companyCount",
    "totalMarketCap",
    "avgSectorGrowth",
    "avgReturn1y",
    "avgMargin",
    "marketCap",
    "revenue",
    "revenueGrowth",
    "netIncome",
    "margin",
    "forwardPE",
    "dividendYield",
    "return1y",
    "employees",
    "favorite",
    "construction",
    "parking",
    "capture",
    "area",
    "time",
  ].includes(columnId) ? "desc" : "asc";
}

export function rowTickerSymbols(row: BuildoutRow): string[] {
  switch (row.kind) {
    case "company":
      return [tickerSymbol(row.item.ticker)].filter((symbol): symbol is string => symbol != null);
    case "site":
      return [
        tickerSymbol(row.item.ownerTicker),
        ...(row.item.builders ?? []).map((builder) => tickerSymbol(builder.companyTicker)),
      ].filter((symbol): symbol is string => symbol != null);
    case "intel":
      return (row.item.companies ?? [])
        .map((company) => tickerSymbol(company.ticker))
        .filter((symbol): symbol is string => symbol != null);
    case "list":
      return [];
  }
}
