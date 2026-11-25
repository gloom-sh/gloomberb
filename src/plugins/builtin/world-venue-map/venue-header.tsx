import type { CloudWorldVenuePayload } from "../../../api-client";
import { colors } from "../../../theme/colors";
import { CountryFlagLead } from "../../../components/ui/country-flag";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { displayWidth } from "../../../utils/format";
import { formatVenueCountdown, formatVenueLocalTime, venueRemainingSeconds, venueSession } from "./model";
import { nextVenueExceptions, venueExceptionLines } from "./venue-exceptions";

export function venueHeaderLines(venue: CloudWorldVenuePayload, checkedAt: number, now: number, width: number) {
  const remaining = formatVenueCountdown(venueRemainingSeconds(venue, checkedAt, now));
  const transition = remaining ? ` · ${venue.isOpen ? "closes" : "opens"} ${remaining}` : "";
  const location = `${venue.city}, ${venue.country}`;
  const clock = `${formatVenueLocalTime(venue.timezone, now)}${transition}`;
  const combined = `${location} · ${clock}`;
  return [
    ...(displayWidth(combined) <= width - 5 ? [combined] : [location, clock]),
    ...venueExceptionLines(nextVenueExceptions(venue.mic, venue.timezone, now), width - 2),
  ];
}

export function SelectedVenueHeader({
  venue,
  width,
  lines,
}: {
  venue: CloudWorldVenuePayload | null;
  width: number;
  lines: string[];
}) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  if (!venue) return <Box height={2} />;
  // A holiday, or a US venue's pre-market and after-hours, says so: "closed" alone read as nothing trading.
  const session = venueSession(venue);
  const state = session.toUpperCase();
  const place = (
    <Text fg={colors.textMuted} wrapMode="none" truncate>{lines[0]}</Text>
  );
  return (
    <Box flexDirection="column" height={1 + lines.length} width={width} paddingX={1} flexShrink={0}>
      <Box flexDirection="row" height={1} justifyContent="space-between" width="100%">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{venue.mic}</Text>
        <Text fg={venue.isOpen ? colors.positive : session === "pre-market" || session === "after-hours" ? colors.warning : colors.textDim}>{state}</Text>
      </Box>
      {desktop ? (
        // The desktop and the web lead the venue's place with its country's flag.
        <Box flexDirection="row" alignItems="center">
          <CountryFlagLead value={venue.countryCode} />
          {place}
        </Box>
      ) : place}
      {lines.slice(1).map((line) => <Text key={line} fg={colors.textMuted} wrapMode="none" truncate>{line}</Text>)}
    </Box>
  );
}
