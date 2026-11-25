import { Box, Text, useUiCapabilities } from "../../../ui";
import { ClippedText } from "../../../components/ui/display";
import type { DataTableCell } from "../../../components";
import { colors, inactiveSelectedText } from "../../../theme/colors";
import { blendForContrast, blendHex } from "../../../theme/color-utils";
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

/**
 * The theme's gain and loss colours, as every pane draws a buy and a sale. A
 * trade under a Rule 10b5-1 plan, set up in advance, takes the side's colour
 * muted, as the chart draws Plan buys and Plan sales.
 */
export function insiderToneColor(tone: InsiderTypeTone, plan = false): string {
  const color = tone === "buy" ? colors.positive : tone === "sell" ? colors.negative : colors.textDim;
  return plan && tone !== "neutral" ? blendHex(color, colors.textDim, 0.55) : color;
}

function typeColor(tone: InsiderTypeTone, plan: boolean, selected: boolean, inactive: boolean): string {
  // On the quieter fill of a pane without the keys, the row keeps its own colours, lifted to read there.
  if (tone === "neutral") return !selected ? colors.textDim : inactive ? inactiveSelectedText(colors.textDim) : colors.selectedText;
  const color = insiderToneColor(tone, plan);
  if (!selected) return color;
  return inactive ? inactiveSelectedText(color) : blendForContrast(color, colors.selected, colors.selectedText, SELECTED_TONE_MIN_CONTRAST);
}

function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** A transaction's type, then its markers, which give way first; cut by CSS on the desktop and the web. */
function InsiderTypeCell({ type, markers, width, color, markerColor }: { type: string; markers: string; width: number; color: string; markerColor: string }) {
  const { nativePaneChrome } = useUiCapabilities();
  if (nativePaneChrome) {
    return (
      <Box flexDirection="row" width={width} overflow="hidden">
        {type ? <ClippedText fg={color} text={type} width={width} /> : null}
        <ClippedText fg={markerColor} lead={type ? " " : ""} text={markers} width={width} flex="0 1000 auto" />
      </Box>
    );
  }
  const label = clipToDisplayWidth(type, width);
  const room = Math.max(0, width - displayWidth(label) - (label ? 1 : 0));
  return (
    <Box flexDirection="row" width={width} overflow="hidden">
      {label ? <Text fg={color}>{label}</Text> : null}
      {room > 0 ? <Text fg={markerColor}>{`${label ? " " : ""}${clipToDisplayWidth(markers, room)}`}</Text> : null}
    </Box>
  );
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
      return { text: formatInsiderDate(row.date, column.compact), value: isoDay(row.date), color: colors.textDim };
    case "insider":
      return { text: row.name, color: row.entry.isLoading ? colors.textDim : colors.text };
    case "role":
      return { text: row.role, color: colors.textMuted };
    case "type": {
      const inactive = rowState.inactive === true;
      const color = typeColor(row.tone, row.plan, rowState.selected, inactive);
      const text = insiderTypeText(row);
      // A plan trade says so in the export, where no chart names the tone.
      const exported = row.plan ? { value: insiderTypeText(row, true) } : {};
      const markers = insiderTypeMarkers(row);
      if (markers.length === 0) return { text, ...exported, color, keepColorWhenSelected: true };
      // The markers read after the type in a quieter colour.
      const markerColor = !rowState.selected ? colors.textMuted : inactive ? inactiveSelectedText(colors.textMuted) : colors.selectedText;
      return {
        text,
        ...exported,
        content: <InsiderTypeCell type={row.type} markers={markers.join(" ")} width={column.width} color={color} markerColor={markerColor} />,
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
