import type { DataTableColumn } from "../../../components";
import type { HeadlessPaneColumn } from "../../../types/plugin";
import type { PublicationKind, PublicationPayload } from "./publications-client";
import { formatCompact } from "../../../utils/format";

export interface PublicationRow {
  id: string;
  date: string;
  sourceUrl: string;
  [key: string]: string | number | null;
}
export interface PublicationColumn extends DataTableColumn {
  detailLabel: string;
  format?: (value: string | number | null) => string;
}
const shares = (value: string | number | null) => value == null ? "--" : formatCompact(Number(value), { fixedDecimals: true });
const percentage = (value: string | number | null) => value == null ? "--" : `${Number(value).toFixed(2)}%`;
const price = (value: string | number | null) => value == null ? "--" : `$${Number(value).toFixed(2)}`;
const FTD_COLUMNS: PublicationColumn[] = [
  { id: "date", label: "SETTLEMENT", detailLabel: "Settlement date", width: 12 },
  { id: "quantity", label: "FAIL SHARES", detailLabel: "Outstanding fail shares", width: 14, align: "right", format: shares },
  { id: "cusip", label: "CUSIP", detailLabel: "CUSIP", width: 11 },
  { id: "price", label: "PRICE (USD)", detailLabel: "Reported price (USD)", width: 13, align: "right", format: price },
  { id: "description", label: "SECURITY", detailLabel: "Security", width: 20, flexGrow: 1 },
];
const ATS_COLUMNS: PublicationColumn[] = [
  { id: "date", label: "WEEK OF", detailLabel: "Week starting", width: 12 },
  { id: "atsShares", label: "ATS SHARES", detailLabel: "ATS shares", width: 14, align: "right", format: shares },
  { id: "nonAtsShares", label: "NON-ATS SHARES", detailLabel: "Non-ATS shares", width: 16, align: "right", format: shares },
  { id: "atsSharePercent", label: "ATS / OTC %", detailLabel: "ATS / published off-exchange shares (%)", width: 14, align: "right", format: percentage },
  { id: "totalShares", label: "OTC SHARES", detailLabel: "Total off-exchange shares", width: 14, align: "right", format: shares },
  { id: "atsTrades", label: "ATS TRADES", detailLabel: "ATS trades", width: 14, align: "right", format: shares },
  { id: "nonAtsTrades", label: "NON-ATS TRADES", detailLabel: "Non-ATS trades", width: 16, align: "right", format: shares },
];
export const publicationColumns = (kind: PublicationKind) => kind === "ftd" ? FTD_COLUMNS : ATS_COLUMNS;
export function publicationRows(data: PublicationPayload): PublicationRow[] {
  return data.history.toReversed().map((row) => "cusip" in row
    ? { ...row, id: `${row.date}:${row.cusip}` }
    : { ...row, id: row.weekStart, date: row.weekStart });
}
export const publicationCell = (column: PublicationColumn, value: string | number | null) =>
  column.format ? column.format(value) : String(value ?? "--");
/** Reports retain exact quantities; compact display values are never the exported data. */
export function publicationReportColumns(kind: PublicationKind): HeadlessPaneColumn[] {
  return publicationColumns(kind).map((column) => ({
    key: column.id, header: column.detailLabel, align: column.align,
    ...(column.id === "atsSharePercent" ? { format: (value: unknown) => percentage(value as number | null) } : {}),
  }));

}
