import { TextAttributes } from "../../../ui";
import type { DataTableCell } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatRelativeTime } from "../../../utils/datetime-format";
import {
  FavoriteCell,
  ListingBadges,
} from "./detail";
import type { DatasetTicker } from "./detail/ui";
import type { BuildoutColumn, BuildoutRow } from "./model/types";
import {
  activityColor,
  activityLabel,
  criticalityColor,
  listWord,
  metricColor,
  moneyAmount,
  moneyText,
  text,
  tickerSymbol,
} from "./format";
import { favoriteKey } from "./table-model";

/** A dollar figure in the compact form, with its whole number for an export. */
function moneyCell(value: string | null | undefined, color: string): DataTableCell {
  const amount = moneyAmount(value);
  return { text: moneyText(value), ...(amount == null ? {} : { value: amount }), color };
}

/**
 * The dataset's tickers in one cell: a chip for each the app can open, bold
 * plain text for one it cannot read, and the same for every row of the column.
 */
function tickerCell(tickers: readonly DatasetTicker[], width: number, selected: boolean): DataTableCell | null {
  const symbols = tickers.flatMap((entry) => tickerSymbol(entry.ticker) ?? []);
  if (symbols.length === 0) return null;
  return {
    text: symbols.join(" "),
    content: <ListingBadges tickers={tickers} width={width} fallbackColor={selected ? colors.selectedText : colors.textBright} />,
  };
}

interface BuildoutCellContext {
  favoriteBusyKey: string | null;
  /** The row's last star did not take. */
  favoriteFailed?: boolean;
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
        return moneyCell(list.totalMarketCap, colors.textDim);
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
              failed={context.favoriteFailed}
              selected={rowState.selected}
              onPress={() => { void context.toggleFavorite(row); }}
            />
          ),
        };
      }
      case "ticker":
        return tickerCell([company], column.width, rowState.selected) ?? { text: "", value: null };
      case "company":
        return { text: company.name, color: colors.text };
      case "description":
        return { text: text(company.description), color: colors.textDim };
      case "sectorTech":
        return { text: text([company.primarySector, company.primaryTechnology].filter(Boolean).join(" / ")), color: colors.textDim };
      case "criticality":
        return { text: text(company.aiCriticality), color: criticalityColor(company.aiCriticality), attributes: TextAttributes.BOLD };
      case "marketCap":
        return moneyCell(company.marketCap, colors.textDim);
      case "revenue":
        return moneyCell(company.revenue, colors.textDim);
      case "revenueGrowth":
        return {
          text: text(company.revenueGrowthYoy ?? company.lastQuarterGrowth),
          color: metricColor(company.revenueGrowthYoy ?? company.lastQuarterGrowth),
        };
      case "netIncome":
        return moneyCell(company.netIncome, metricColor(company.netIncome));
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
      case "listRole":
        return { text: text(listWord(company.listRole)), color: colors.textDim };
      case "listTier":
        return { text: text(listWord(company.listTier)), color: company.listTier === "leader" ? colors.text : colors.textDim };
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
              failed={context.favoriteFailed}
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
      case "owner":
        return tickerCell([{ ticker: site.ownerTicker }], column.width, rowState.selected)
          ?? { text: text(site.ownerName), color: colors.textDim };
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
      case "companies":
        return tickerCell(update.companies ?? [], column.width, rowState.selected)
          ?? { text: text(update.companies?.map((company) => company.name).filter(Boolean).join(", ")), color: colors.textDim };
      case "headline":
        return { text: update.headline, color: colors.text };
    }
  }

  return { text: "" };
}
