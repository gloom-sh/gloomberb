/**
 * Data people look for that no source here carries yet, each with the nearest
 * thing the app does quote. `search` and `catalog` answer a query that names
 * one with this line instead of pointing at each other. One entry per gap;
 * every proxy named is a listing `gloomberb quote` answers (checked
 * 2026-10-11: CO2:LSE is the physical EUA ETC, while a bare CO2 is a Brent
 * future).
 */
const KNOWN_GAPS: ReadonlyArray<{ terms: readonly string[]; message: string }> = [
  {
    terms: ["EUA", "EUAs", "EU ETS", "EU allowance", "EU allowances", "EU carbon", "carbon", "carbon allowance", "carbon allowances",
      "carbon price", "carbon prices", "carbon credits", "emission allowances", "emissions allowances"],
    message: "No EU carbon price (EUA) yet. Proxies: CO2:LSE, KRBN.",
  },
];

/** Letters and digits only, lower case: `EU-ETS`, `eu ets` and `EUETS` are one lookup. */
function lookupKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The line for a query that names a known gap as a whole ("carbon allowances", "EUA"), else null. */
export function knownGapMessage(query: string): string | null {
  const key = lookupKey(query);
  if (!key) return null;
  return KNOWN_GAPS.find((gap) => gap.terms.some((term) => lookupKey(term) === key))?.message ?? null;
}
