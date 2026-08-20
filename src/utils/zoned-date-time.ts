export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function zonedDateTimeParts(utcMs: number, timeZone: string): ZonedDateTimeParts {
  const parts = new Map<string, string>();
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts.set(part.type, part.value);
  }
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
    second: Number(parts.get("second")),
  };
}

function zonedOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zonedDateTimeParts(utcMs, timeZone);
  const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallMs - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a wall-clock reading in an IANA timezone to a real UTC instant. */
export function zonedWallClockToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond = 0,
): number {
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const firstOffset = zonedOffsetMs(wallMs, timeZone);
  const candidate = wallMs - firstOffset;
  const verifiedOffset = zonedOffsetMs(candidate, timeZone);
  return wallMs - verifiedOffset;
}
