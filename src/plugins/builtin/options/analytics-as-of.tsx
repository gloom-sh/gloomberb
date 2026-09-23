import { DialogFrame, KeyValueRow } from "../../../components";
import { Box } from "../../../ui";
import { useDialogKeyboard, type AlertContext } from "../../../ui/dialog";
import { isPlainKey } from "../../../utils/keyboard";
import type { OptionsEnrichmentSnapshot } from "./enrichment-model";

export interface AnalyticsAsOfRow {
  label: string;
  value: string;
}

/** When each input to the chain analytics was observed. */
export function analyticsAsOfRows(enrichment: OptionsEnrichmentSnapshot): AnalyticsAsOfRow[] {
  return [
    { label: "Selected", value: enrichment.asOf ?? "unavailable" },
    { label: "Adjacent", value: enrichment.neighbourAsOf ?? "unavailable" },
    { label: "Treasury", value: enrichment.rateAsOf.join(", ") || "unavailable" },
    { label: "Underlying mark", value: `${enrichment.spot} as of ${enrichment.spotAsOf ?? "unavailable"}` },
  ];
}

/** The footer's analytics time in full, for the keyboard and the terminal, which have no tooltip. */
export function AnalyticsAsOfDialog({ rows, dismiss }: AlertContext & { rows: AnalyticsAsOfRow[] }) {
  useDialogKeyboard((event) => {
    if (!isPlainKey(event, "escape", "enter", "return")) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  const labelWidth = Math.max(...rows.map((row) => row.label.length)) + 2;
  const width = Math.max(40, labelWidth + Math.max(...rows.map((row) => row.value.length)));
  return (
    <DialogFrame title="Analytics as of" onClose={dismiss}>
      <Box flexDirection="column" width={width}>
        {rows.map((row) => (
          <KeyValueRow key={row.label} label={row.label} labelWidth={labelWidth} value={row.value} emphasis={false} />
        ))}
      </Box>
    </DialogFrame>
  );
}
