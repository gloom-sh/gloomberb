import { TextAttributes } from "../../../ui";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatBrokerUpdatedAt, type BrokerDisplayState, type BrokerProfileRow } from "./model";
import { t } from "../../../i18n";
import { truncateToDisplayWidth } from "../../../utils/format";

type BrokerColumnId = "profile" | "status" | "broker" | "mode" | "accounts" | "updated";
export type BrokerColumn = DataTableColumn & { id: BrokerColumnId };

export function stateColor(state: BrokerDisplayState): string {
  switch (state) {
    case "connected": return colors.positive;
    case "connecting": return colors.warning;
    case "error": return colors.negative;
    case "disabled": return colors.textMuted;
    case "unavailable": return colors.negative;
    default: return colors.textDim;
  }
}

export function truncate(value: string, width: number): string {
  return truncateToDisplayWidth(value, width);
}

export function isBrokerErrorMessage(message: string | null | undefined): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("failed") || normalized.includes("required");
}

/** Below this the mode column folds away rather than pushing SYNCED off the edge. */
const MODE_COLUMN_MIN_WIDTH = 84;

export function buildBrokerColumns(width: number): BrokerColumn[] {
  // PROFILE takes whatever the fixed columns leave; the kit spreads it.
  return [
    { id: "profile", label: t("PROFILE"), width: 14, align: "left", flexGrow: 1 },
    { id: "status", label: t("STATUS"), width: 12, align: "left" },
    { id: "broker", label: t("BROKER"), width: width >= 110 ? 20 : 16, align: "left" },
    ...(width >= MODE_COLUMN_MIN_WIDTH
      ? [{ id: "mode" as const, label: t("MODE"), width: 11, align: "left" as const }]
      : []),
    { id: "accounts", label: t("ACCOUNTS"), width: 12, align: "right" },
    { id: "updated", label: t("SYNCED"), width: 9, align: "right" },
  ];
}

export function renderBrokerCell(row: BrokerProfileRow, column: BrokerColumn): DataTableCell {
  switch (column.id) {
    case "profile":
      return {
        text: row.label,
        color: colors.text,
        attributes: TextAttributes.BOLD,
      };
    case "status":
      return {
        text: row.stateLabel,
        color: stateColor(row.state),
      };
    case "broker":
      return { text: row.brokerName, color: colors.textDim };
    case "mode":
      return { text: row.mode, color: colors.textDim };
    case "accounts":
      return { text: row.accountSummary, color: row.accountCount > 0 ? colors.text : colors.textMuted };
    case "updated":
      return { text: formatBrokerUpdatedAt(row.lastSyncedAt), color: colors.textMuted };
  }
}
