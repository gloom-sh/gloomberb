import { createElement } from "react";
import { TextAttributes } from "../../../ui";
import { LogoMark } from "../../../components/ui/logo-mark";
import type { DataTableCell, DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatRelativeAge } from "../../../utils/datetime-format";
import type { BrokerDisplayState, BrokerProfileRow } from "./model";
import type { BrokerRowActivity } from "./pane-actions";
import { t } from "../../../i18n";
import { signInEndStatus } from "./sign-in-end";

type BrokerColumnId = "profile" | "status" | "broker" | "mode" | "accounts" | "updated";
export type BrokerColumn = DataTableColumn & { id: BrokerColumnId };

function stateColor(state: BrokerDisplayState): string {
  switch (state) {
    case "connected": return colors.positive;
    case "connecting": return colors.warning;
    case "error": return colors.negative;
    // Nothing syncs these until the user steps in.
    case "sign-in": return colors.warning;
    case "disabled": return colors.warning;
    case "unavailable": return colors.negative;
    default: return colors.textDim;
  }
}

/** Below this the mode column folds away rather than pushing SYNCED off the edge. */
const MODE_COLUMN_MIN_WIDTH = 84;

export function buildBrokerColumns(width: number): BrokerColumn[] {
  // PROFILE takes whatever the fixed columns leave; the kit spreads it.
  return [
    { id: "profile", label: t("PROFILE"), width: 14, align: "left", flexGrow: 1 },
    // Holds "Sign-in needed" and "Connect failed".
    { id: "status", label: t("STATUS"), width: 14, align: "left" },
    { id: "broker", label: t("BROKER"), width: width >= 110 ? 20 : 16, align: "left" },
    ...(width >= MODE_COLUMN_MIN_WIDTH
      ? [{ id: "mode" as const, label: t("MODE"), width: 11, align: "left" as const }]
      : []),
    { id: "accounts", label: t("ACCOUNTS"), width: 12, align: "right" },
    { id: "updated", label: t("SYNCED"), width: 9, align: "right" },
  ];
}

/**
 * What a profile's STATUS says, in the table and atop its detail: the action
 * running on it, then the one that just failed on it, then a sign-in the
 * broker is about to end, then its own state ("Disabled", "Sign-in needed").
 */
export function brokerRowStatus(row: BrokerProfileRow, activity: BrokerRowActivity = {}): { text: string; color: string } {
  if (activity.busy) return { text: activity.busy, color: colors.warning };
  // A sign-in the broker wants says more than which step ran into it.
  if (activity.note?.status && row.state !== "sign-in") return { text: activity.note.status, color: colors.negative };
  // A sign-in the broker is about to end replaces "Connected" until it is renewed.
  if (row.signInEndsAt !== null) return { text: signInEndStatus(row.signInEndsAt), color: colors.warning };
  return { text: row.stateLabel, color: stateColor(row.state) };
}

/** `desktop`: the profile leads with its broker's logo, which the terminal does not draw. */
export function renderBrokerCell(
  row: BrokerProfileRow,
  column: BrokerColumn,
  desktop = false,
  activity: BrokerRowActivity = {},
): DataTableCell {
  switch (column.id) {
    case "profile":
      return {
        text: row.label,
        color: colors.text,
        attributes: TextAttributes.BOLD,
        leading: desktop ? createElement(LogoMark, { src: row.logo, name: row.brokerName }) : undefined,
      };
    case "status":
      return brokerRowStatus(row, activity);
    case "broker":
      return { text: row.brokerName, color: colors.textDim };
    case "mode":
      return { text: row.mode, color: colors.textDim };
    case "accounts":
      return { text: row.accountSummary, color: row.accountCount > 0 ? colors.text : colors.textMuted };
    case "updated":
      return { text: formatRelativeAge(row.lastSyncedAt), color: colors.textMuted };
  }
}
