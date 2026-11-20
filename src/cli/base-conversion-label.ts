import { quotedFxPair } from "../utils/currency-pair";
import { formatUtcDayTime } from "../utils/utc-time";
import type { BaseConversion } from "./base-converter";
import { formatFxRate } from "./fx-pair";

export function baseConversionLabel({ currency, baseCurrency, rate, asOf, stale }: BaseConversion, dateOnly = false): string {
  const quoted = quotedFxPair(currency, baseCurrency, rate);
  const time = asOf == null ? "time unavailable" : `${formatUtcDayTime({ time: asOf, dateOnly })}${dateOnly ? " close" : " UTC"}`;
  return `${quoted.pair} ${formatFxRate(quoted.rate)} · ${time}${stale ? " (stale)" : ""}`;
}
