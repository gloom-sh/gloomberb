import { TextAttributes } from "../../../ui";
import { TickerBadgeList, type DataTableCell } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatRelativeTime } from "../../../utils/datetime-format";
import {
  CompanyCell,
  FavoriteCell,
} from "./detail";
import type { BuildoutColumn, BuildoutRow } from "./model/types";
import {
  activityColor,
  activityLabel,
  criticalityColor,
  metricColor,
  text,
  tickerSymbol,
} from "./format";
import { favoriteKey } from "./table-model";

interface BuildoutCellContext {
  favoriteBusyKey: string | null;
  toggleFavorite: (row: BuildoutRow) => void | Promise<void>;
}

export function renderBuildoutCell(
  row: BuildoutRow,
  column: BuildoutColumn,
  rowState: { selected: boolean },
  context: BuildoutCellContext,
): DataTableCell {
  if (row.kind === "list") {
    const list = row.item;
    switch (column.id) {
      case "listName":
        return { text: list.name, color: colors.text };
      case "listDescription":
        return { text: text(list.shortDescription ?? list.description), color: colors.textDim };
      case "companyCount":
        return { text: list.companyCount == null ? "-" : String(list.companyCount), color: colors.textDim };
      case "totalMarketCap":
        return { text: text(list.totalMarketCap), color: colors.textDim };
      case "avgSectorGrowth":
        return { text: text(list.avgSectorGrowth), color: metricColor(list.avgSectorGrowth) };
      case "avgReturn1y":
        return { text: text(list.avgReturn1y), color: metricColor(list.avgReturn1y) };
      case "avgMargin":
        return { text: text(list.avgMargin), color: metricColor(list.avgMargin) };
    }
  }

  if (row.kind === "company") {
    const company = row.item;
    switch (column.id) {
      case "favorite": {
        const key = favoriteKey(row);
        const busy = key != null && context.favoriteBusyKey === key;
        return {
          text: company.starred ? "★" : "☆",
          content: (
            <FavoriteCell
              starred={company.starred === true}
              busy={busy}
              selected={rowState.selected}
              onPress={() => { void context.toggleFavorite(row); }}
            />
          ),
        };
      }
      case "company":
        return {
          text: company.ticker ? `${company.ticker} ${company.name}` : company.name,
          content: (
            <CompanyCell
              company={company}
              width={column.width}
              selected={rowState.selected}
            />
          ),
        };
      case "description":
        return { text: text(company.description), color: colors.textDim };
      case "sectorTech":
        return { text: text([company.primarySector, company.primaryTechnology].filter(Boolean).join(" / ")), color: colors.textDim };
      case "criticality":
        return { text: text(company.aiCriticality), color: criticalityColor(company.aiCriticality), attributes: TextAttributes.BOLD };
      case "marketCap":
        return { text: text(company.marketCap), color: colors.textDim };
      case "revenue":
        return { text: text(company.revenue), color: colors.textDim };
      case "revenueGrowth":
        return {
          text: text(company.revenueGrowthYoy ?? company.lastQuarterGrowth),
          color: metricColor(company.revenueGrowthYoy ?? company.lastQuarterGrowth),
        };
      case "netIncome":
        return { text: text(company.netIncome), color: metricColor(company.netIncome) };
      case "margin":
        return { text: text(company.profitMargins), color: metricColor(company.profitMargins) };
      case "forwardPE":
        return { text: text(company.forwardPE), color: colors.textDim };
      case "dividendYield":
        return { text: text(company.dividendYield), color: metricColor(company.dividendYield) };
      case "return1y":
        return { text: text(company.return1y), color: metricColor(company.return1y) };
      case "employees":
        return { text: text(company.employeeCount), color: colors.textDim };
    }
  }

  if (row.kind === "site") {
    const site = row.item;
    const location = [site.location?.city, site.location?.country].filter(Boolean).join(", ");
    switch (column.id) {
      case "favorite": {
        const key = favoriteKey(row);
        const busy = key != null && context.favoriteBusyKey === key;
        return {
          text: site.starred ? "★" : "☆",
          content: (
            <FavoriteCell
              starred={site.starred === true}
              busy={busy}
              selected={rowState.selected}
              onPress={() => { void context.toggleFavorite(row); }}
            />
          ),
        };
      }
      case "site":
        return { text: site.name, color: colors.text };
      case "type":
        return { text: text(site.type), color: colors.textDim };
      case "owner": {
        const ownerTicker = tickerSymbol(site.ownerTicker);
        if (ownerTicker) {
          return {
            text: ownerTicker,
            content: (
              <TickerBadgeList
                symbols={[ownerTicker]}
                width={column.width}
                fallbackColor={rowState.selected ? colors.selectedText : colors.textBright}
              />
            ),
          };
        }
        return { text: text(site.ownerName), color: colors.textDim };
      }
      case "location":
        return { text: text(location), color: colors.textDim };
      case "park":
        return { text: text(site.parkName), color: colors.textDim };
      case "power":
        return { text: text(site.powerCapacity), color: colors.textDim };
      case "construction":
        return { text: activityLabel(site.constructionActivity), color: activityColor(site.constructionActivity) };
      case "parking":
        return { text: activityLabel(site.parkingActivity), color: activityColor(site.parkingActivity) };
      case "capture":
        return { text: formatRelativeTime(site.latestCapture), color: colors.textDim };
      case "area":
        return { text: text(site.areaKm2), color: colors.textDim };
    }
  }

  if (row.kind === "intel") {
    const update = row.item;
    switch (column.id) {
      case "time":
        return { text: formatRelativeTime(update.publishedAt), color: colors.textDim };
      case "companies": {
        const symbols = (update.companies ?? [])
          .map((company) => tickerSymbol(company.ticker))
          .filter((symbol): symbol is string => symbol != null);
        return symbols.length > 0
          ? {
            text: symbols.join(" "),
            content: (
              <TickerBadgeList
                symbols={symbols}
                width={column.width}
                fallbackColor={rowState.selected ? colors.selectedText : colors.textBright}
              />
            ),
          }
          : { text: text(update.companies?.map((company) => company.name).filter(Boolean).join(", ")), color: colors.textDim };
      }
      case "headline":
        return { text: update.headline, color: colors.text };
    }
  }

  return { text: "" };
}
