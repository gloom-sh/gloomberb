const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A futures contract month as every pane and report writes it, "Oct 2026":
 * "Oct 26" reads as the 26th of October. `month` is 0-11; a two-digit year
 * (the 26 of HGZ26) is in this century.
 */
export function contractMonthLabel(year: number, month: number): string {
  return `${MONTHS[month] ?? String(month + 1).padStart(2, "0")} ${year < 100 ? 2000 + year : year}`;
}

/** A delivery month, "2026-10", "2026-10-01" or a broker's "202610", as contractMonthLabel writes it; null when it is no month. */
export function deliveryMonthLabel(deliveryMonth: string | null | undefined): string | null {
  const match = /^(\d{4})-?(0[1-9]|1[0-2])(?:$|-)/.exec(deliveryMonth ?? "");
  return match ? contractMonthLabel(Number(match[1]), Number(match[2]) - 1) : null;
}
