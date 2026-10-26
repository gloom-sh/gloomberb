import type { CloudWorldVenuePayload } from "../../../api-client";
import { colors } from "../../../theme/colors";
import { CountryFlagLead } from "../../../components/ui/country-flag";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
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
  const desktop = useUiCapabilities().nativePaneChrome === true;
  if (!venue) return <Box height={2} />;
  const remaining = formatVenueCountdown(venueRemainingSeconds(venue, checkedAt, now));
  const state = venue.isOpen ? "OPEN" : "CLOSED";
  const transition = remaining ? `${venue.isOpen ? "closes" : "opens"} ${remaining}` : "";
  const place = (
    <Text fg={colors.textMuted}>
      {`${venue.city}, ${venue.country} · ${formatVenueLocalTime(venue.timezone, now)}${transition ? ` · ${transition}` : ""}`}
    </Text>
  );
  return (
    <Box flexDirection="column" height={2} width={width} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{venue.mic}</Text>
        <Text fg={venue.isOpen ? colors.positive : colors.textDim}>{state}</Text>
      </Box>
      {desktop ? (
        // The desktop and the web lead the venue's place with its country's flag.
        <Box flexDirection="row" alignItems="center">
          <CountryFlagLead value={venue.countryCode} />
          {place}
        </Box>
      ) : place}
    </Box>
  );
}
