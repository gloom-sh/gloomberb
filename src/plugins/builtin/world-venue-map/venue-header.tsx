import type { CloudWorldVenuePayload } from "../../../api-client";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes } from "../../../ui";
import { formatVenueCountdown, formatVenueLocalTime, venueRemainingSeconds } from "./model";

export function SelectedVenueHeader({
  venue,
  checkedAt,
  now,
  width,
}: {
  venue: CloudWorldVenuePayload | null;
  checkedAt: number;
  now: number;
  width: number;
}) {
  if (!venue) return <Box height={2} />;
  const remaining = formatVenueCountdown(venueRemainingSeconds(venue, checkedAt, now));
  const state = venue.isOpen ? "OPEN" : "CLOSED";
  const transition = remaining ? `${venue.isOpen ? "closes" : "opens"} ${remaining}` : "";
  return (
    <Box flexDirection="column" height={2} width={width} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{venue.mic}</Text>
        <Text fg={venue.isOpen ? colors.positive : colors.textDim}>{state}</Text>
      </Box>
      <Text fg={colors.textMuted}>
        {`${venue.city}, ${venue.country} · ${formatVenueLocalTime(venue.timezone, now)}${transition ? ` · ${transition}` : ""}`}
      </Text>
    </Box>
  );
}
