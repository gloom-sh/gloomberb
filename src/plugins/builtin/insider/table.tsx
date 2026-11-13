import { Box, Text } from "../../../ui";
import type { DataTableCell } from "../../../components";
import { colors, inactiveSelectedText } from "../../../theme/colors";
import { blendForContrast } from "../../../theme/color-utils";
import { clipToDisplayWidth, displayWidth } from "../../../utils/format";
import type { InsiderTypeTone } from "./display";
import {
  formatInsiderDate,
  formatInsiderPrice,
  formatInsiderShares,
  formatInsiderValue,
  insiderCurrencyText,
  insiderTypeMarkers,
  insiderTypeText,
  type InsiderColumn,
  type InsiderTableRow,
} from "./table-model";

/** The contrast a buy or sell keeps against the selected row. */
const SELECTED_TONE_MIN_CONTRAST = 3.6;

/** The theme's gain and loss colours, as every pane draws a buy and a sale. */
export function insiderToneColor(tone: InsiderTypeTone): string {
  return tone === "buy" ? colors.positive : tone === "sell" ? colors.negative : colors.textDim;
}

function typeColor(tone: InsiderTypeTone, selected: boolean, inactive: boolean): string {
  // On the quieter fill of a pane without the keys, the row keeps its own colours, lifted to read there.
  if (tone === "neutral") return !selected ? colors.textDim : inactive ? inactiveSelectedText(colors.textDim) : colors.selectedText;
  const color = insiderToneColor(tone);
  if (!selected) return color;
  return inactive ? inactiveSelectedText(color) : blendForContrast(color, colors.selected, colors.selectedText, SELECTED_TONE_MIN_CONTRAST);
}

function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

export function renderInsiderCell(
  row: InsiderTableRow,
  column: InsiderColumn,
  _index: number,
  rowState: { selected: boolean; inactive?: boolean },
): DataTableCell {
  // Awards, exercises and tax lines are context; buys and sales carry the figures.
  const figureColor = row.tone === "neutral" ? colors.textDim : colors.text;
  switch (column.id) {
    case "date":
      return { text: formatInsiderDate(row.date), value: isoDay(row.date), color: colors.textDim };
    case "insider":
      return { text: row.name, color: row.entry.isLoading ? colors.textDim : colors.text };
    case "role":
      return { text: row.role, color: colors.textMuted };
    case "type": {
      const inactive = rowState.inactive === true;
      const color = typeColor(row.tone, rowState.selected, inactive);
      const text = insiderTypeText(row, column.plan === true);
      const markers = insiderTypeMarkers(row, column.plan === true);
      if (markers.length === 0) return { text, color, keepColorWhenSelected: true };
      // The markers read after the type in a quieter colour.
      const markerColor = !rowState.selected ? colors.textMuted : inactive ? inactiveSelectedText(colors.textMuted) : colors.selectedText;
      const label = clipToDisplayWidth(row.type, column.width);
      const room = Math.max(0, column.width - displayWidth(label) - (label ? 1 : 0));
      return {
        text,
        content: (
          <Box flexDirection="row" width={column.width} overflow="hidden">
            {label ? <Text fg={color}>{label}</Text> : null}
            {room > 0 ? <Text fg={markerColor}>{`${label ? " " : ""}${clipToDisplayWidth(markers.join(" "), room)}`}</Text> : null}
          </Box>
        ),
      };
    }
    case "security":
      return { text: row.security ?? "", value: row.entry.transaction?.securityTitle || null, color: colors.textMuted };
    case "shares":
      return { text: formatInsiderShares(row.shares), value: row.shares, color: figureColor };
    case "price":
      return { text: formatInsiderPrice(row.price, column.currency), value: row.price, color: figureColor };
    case "value":
      return { text: formatInsiderValue(row.value, column.currency), value: row.value, color: figureColor };
    case "ccy":
      return { text: insiderCurrencyText(row, column.currency ?? ""), color: colors.textMuted };
  }
}
