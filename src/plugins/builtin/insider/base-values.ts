import type { HeadlessPaneColumn, HeadlessPaneRow } from "../../../types/headless";
import { fxCloseOnOrBefore, loadDailyFxCloses, type FxCloses, type FxHistoryClient } from "../../../market-data/fx-closes";
import { logFailure } from "../../../utils/log-failure";
import { formatCompact, formatNumber } from "../../../utils/format";

/** A Form 4 states its prices and values in US dollars. */
export const FORM4_CURRENCY = "USD";

/** The rows with their currency, and for a base currency other than USD each value in it, with the columns and note that say so. */
export interface InsiderBaseValues {
  rows: HeadlessPaneRow[];
  /** The money columns labelled with their currency, and the converted value and its rate; null for a USD base, whose columns stay as they are. */
  columns: HeadlessPaneColumn[] | null;
  note: string | null;
}

const dash = (value: unknown, format: (value: number) => string) => (typeof value === "number" && Number.isFinite(value) ? format(value) : "-");

/**
 * Every row carries the currency its price and value are in (USD, as a Form 4
 * states them). With another base currency (CAD), each value is also given
 * in it at the daily close of USD/CAD on its transaction day, or the last
 * close before a weekend or holiday (`fxCloseOnOrBefore` over the history
 * PORT and PEB read), with the rate and that close's date beside it. When the
 * closes cannot be read the values stay in USD and the note says why.
 */
export async function withInsiderBaseValues(
  rows: readonly HeadlessPaneRow[],
  baseCurrency: string,
  client: FxHistoryClient,
  now = new Date(),
): Promise<InsiderBaseValues> {
  const labelled: HeadlessPaneRow[] = rows.map((row) => ({ ...row, currency: FORM4_CURRENCY }));
  const base = baseCurrency.trim().toUpperCase();
  if (!base || base === FORM4_CURRENCY) return { rows: labelled, columns: null, note: null };
  const pair = `${FORM4_CURRENCY}/${base}`;
  const days = labelled.flatMap((row) => typeof row.transactionDate === "string" && typeof row.totalValue === "number"
    ? [row.transactionDate.slice(0, 10)] : []).sort();
  let closes: FxCloses | null = null;
  if (days.length > 0) {
    try {
      closes = await loadDailyFxCloses(base, days[0]!, client, now);
    } catch (error) {
      logFailure("insider.base-values", `Daily ${pair} closes failed`)(error);
    }
  }
  const converted = labelled.map((row) => {
    const day = typeof row.transactionDate === "string" ? row.transactionDate.slice(0, 10) : null;
    const reading = closes && day && typeof row.totalValue === "number" ? fxCloseOnOrBefore(closes, day) : null;
    // The close is USD per unit of the base currency; the rate is the base currency per dollar.
    const fxRate = reading ? 1 / reading.rate : null;
    return {
      ...row,
      baseCurrency: base,
      valueBase: fxRate != null ? (row.totalValue as number) * fxRate : null,
      fxRate,
      fxDate: reading?.date ?? null,
    };
  });
  const columns: HeadlessPaneColumn[] = [
    { key: "pricePerShare", header: `Price (${FORM4_CURRENCY})`, align: "right", format: (value) => dash(value, (price) => formatNumber(price, 2)) },
    { key: "totalValue", header: `Value (${FORM4_CURRENCY})`, align: "right", format: (value) => dash(value, formatCompact) },
    ...closes ? [
      { key: "valueBase", header: `Value (${base})`, align: "right" as const, format: (value: unknown) => dash(value, formatCompact) },
      { key: "fxRate", header: pair, align: "right" as const, stackPriority: 1, format: (value: unknown) => dash(value, (rate) => formatNumber(rate, 4)) },
    ] : [],
  ];
  const note = days.length === 0 ? null
    : closes ? `Value (${base}) is each value at the ${pair} daily close of its transaction day, or of the trading day before it; ${pair} is that rate.`
      : `Daily ${pair} closes are unavailable, so values stay in ${FORM4_CURRENCY}.`;
  return { rows: closes ? converted : labelled, columns, note };
}
