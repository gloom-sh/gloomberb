import type { CloudSessionMoversCategory } from "../../../api-client/market-movers";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { getTableWidth } from "../../../components/ui/table-layout";
import { colors, priceColor } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import { formatMoverPrice, moverReferencePrice } from "./model";
import { leadCatalyst, type SessionMoverColumnId, type SessionMoverRow } from "./session";
import { formatVolRatio, volRatioColor } from "./table";

export type SessionMoverColumn = DataTableColumn & { id: SessionMoverColumnId };

const VOLUME_LABEL: Record<CloudSessionMoversCategory, string> = {
  premarket: "PRE VOL",
  afterhours: "AH VOL",
  gaps: "VOL",
};

/**
 * Pre-market and after hours: last, change from the reference close, session
 * volume, relative volume, float and the catalyst. Gaps add the gap and the
 * distance from VWAP. The name gives way first, then the columns a narrow pane
 * can do without (the day's volume, then the float).
 */
export function buildSessionMoverColumns(view: CloudSessionMoversCategory, width: number): SessionMoverColumn[] {
  const columns: SessionMoverColumn[] = [
    { id: "rank", label: "#", width: 3, align: "left" },
    { id: "symbol", label: "TICKER", width: 8, align: "left" },
    { id: "name", label: "NAME", width: 6, align: "left" },
    { id: "price", label: "LAST", width: 10, align: "right" },
    ...(view === "gaps" ? [{ id: "gapPercent" as const, label: "GAP%", width: 8, align: "right" as const }] : []),
    { id: "changePercent", label: "CHG%", width: 8, align: "right" },
    { id: "volume", label: VOLUME_LABEL[view], width: 8, align: "right" },
    { id: "relativeVolume", label: "RVOL", width: 6, align: "right" },
    ...(view === "gaps" ? [{ id: "vwapPercent" as const, label: "VWAP%", width: 7, align: "right" as const }] : []),
    { id: "floatShares", label: "FLOAT", width: 7, align: "right" },
    { id: "catalyst", label: "EVENT", width: 6, align: "left" },
  ];
  const optional: SessionMoverColumnId[] = view === "gaps" ? ["volume", "floatShares"] : ["floatShares"];
  // Measured the way the table draws it: a header widens its column, and a
  // left-aligned column after a right-aligned one gets a lead gap. The name
  // sits between left-aligned columns, so it adds only its width and a gutter.
  const nameRoom = () => width - getTableWidth(columns.filter((column) => column.id !== "name")) - 1;
  const minName = 12;
  for (const id of optional) {
    if (nameRoom() >= minName) break;
    columns.splice(columns.findIndex((column) => column.id === id), 1);
  }
  columns.find((column) => column.id === "name")!.width = Math.max(6, nameRoom());
  return columns;
}

const CATALYST_LABEL = { halt: "Halt", filing: "8-K", news: "News" } as const;

function signedPercent(value: number | null): DataTableCell {
  return {
    text: value == null ? "—" : formatPercentRaw(value),
    value,
    color: value == null ? colors.textDim : priceColor(value),
  };
}

export function renderSessionMoverCell(row: SessionMoverRow, column: SessionMoverColumn): DataTableCell {
  switch (column.id) {
    case "rank":
      return { text: String(row.rank), color: colors.textDim };
    case "symbol":
      return { text: row.symbol, color: colors.textBright, attributes: TextAttributes.BOLD };
    case "name":
      return { text: row.name };
    case "price":
      return { text: formatMoverPrice(row.price, row.currency, moverReferencePrice({ ...row, previousClose: row.referenceClose })), value: row.price };
    case "gapPercent":
      return signedPercent(row.gapPercent);
    case "changePercent":
      return signedPercent(row.changePercent);
    case "vwapPercent":
      return signedPercent(row.vwapPercent);
    case "volume":
      return { text: formatCompact(row.volume, { fixedDecimals: true }), value: row.volume, color: colors.textDim };
    case "relativeVolume":
      return { text: formatVolRatio(row.relativeVolume), value: row.relativeVolume, color: volRatioColor(row.relativeVolume) };
    case "floatShares":
      return {
        text: row.floatShares == null ? "—" : formatCompact(row.floatShares, { fixedDecimals: true }),
        value: row.floatShares,
        color: colors.textDim,
      };
    case "catalyst": {
      const lead = leadCatalyst(row);
      if (!lead) return { text: "", value: null };
      // A halt is the one marker that changes what can be traded right now.
      return { text: CATALYST_LABEL[lead], value: CATALYST_LABEL[lead], color: lead === "halt" ? colors.warning : colors.text };
    }
  }
}
