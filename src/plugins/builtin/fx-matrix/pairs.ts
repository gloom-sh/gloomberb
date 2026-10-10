/** The default board, in its default order. */
export const MAJOR_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;

/**
 * Every currency the board can carry, in the order its settings list them: the
 * majors, the other liquid currencies, then emerging markets by region.
 */
export const FX_CURRENCIES = [
  ...MAJOR_CURRENCIES,
  "SEK", "NOK", "DKK", "HKD", "SGD", "CNY", "CNH",
  "KRW", "TWD", "INR", "IDR", "MYR", "PHP", "THB", "VND", "PKR",
  "PLN", "CZK", "HUF", "RON", "UAH", "TRY", "KZT",
  "ILS", "SAR", "AED", "QAR", "EGP", "ZAR", "NGN", "KES",
  "MXN", "BRL", "CLP", "COP", "PEN", "ARS",
] as const;
export type FxCurrency = typeof FX_CURRENCIES[number];

/** The flag each currency wears on the desktop and web; the euro is the EU's, not one member's. */
export const CURRENCY_FLAG_REGIONS: Record<FxCurrency, string> = {
  USD: "US", EUR: "EU", GBP: "GB", JPY: "JP", CHF: "CH", CAD: "CA", AUD: "AU", NZD: "NZ",
  SEK: "SE", NOK: "NO", DKK: "DK", HKD: "HK", SGD: "SG", CNY: "CN", CNH: "CN",
  KRW: "KR", TWD: "TW", INR: "IN", IDR: "ID", MYR: "MY", PHP: "PH", THB: "TH", VND: "VN", PKR: "PK",
  PLN: "PL", CZK: "CZ", HUF: "HU", RON: "RO", UAH: "UA", TRY: "TR", KZT: "KZ",
  ILS: "IL", SAR: "SA", AED: "AE", QAR: "QA", EGP: "EG", ZAR: "ZA", NGN: "NG", KES: "KE",
  MXN: "MX", BRL: "BR", CLP: "CL", COP: "CO", PEN: "PE", ARS: "AR",
};

/** One-pick selections in the pane settings. Each fills the currency list, which stays editable. */
export const CURRENCY_SETS: readonly { id: string; label: string; currencies: readonly FxCurrency[] }[] = [
  { id: "majors", label: "Majors", currencies: MAJOR_CURRENCIES },
  { id: "g10", label: "G10", currencies: [...MAJOR_CURRENCIES, "SEK", "NOK"] },
  {
    id: "asia",
    label: "Asia",
    currencies: ["USD", "JPY", "CNY", "CNH", "HKD", "SGD", "TWD", "KRW", "INR", "IDR", "MYR", "PHP", "THB", "VND", "PKR"],
  },
  {
    id: "emea",
    label: "EMEA",
    currencies: [
      "USD", "EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "UAH", "TRY", "KZT",
      "ILS", "SAR", "AED", "QAR", "EGP", "ZAR", "NGN", "KES",
    ],
  },
  { id: "americas", label: "Americas", currencies: ["USD", "CAD", "MXN", "BRL", "CLP", "COP", "PEN", "ARS"] },
  { id: "all", label: "All", currencies: FX_CURRENCIES },
];

/**
 * Decimals follow the rate's size, counted at `referenceRate` (the cross at a
 * rate that holds still) when there is one, so a live rate ticking across a
 * power of ten, such as JPY/AUD near 0.0100, keeps its decimals. From 50 up a
 * rate reads two decimals (149.25, 1340.50, 33000.12); below 0.1 it keeps five
 * significant digits, to eight decimals; everything between reads four.
 */
export function formatRate(rate: number, referenceRate = rate): string {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  const basis = Number.isFinite(referenceRate) && referenceRate > 0 ? referenceRate : rate;
  const decimals = basis < 0.1 ? Math.min(8, 4 - Math.floor(Math.log10(basis))) : basis >= 50 ? 2 : 4;
  return rate.toFixed(decimals);
}

export function isFxCurrency(code: unknown): code is FxCurrency {
  return typeof code === "string" && FX_CURRENCIES.includes(code as FxCurrency);
}

/**
 * The saved currency selection in its saved order, falling back to the majors
 * when it is empty or holds no code this board carries. Unknown codes and
 * repeats drop out. A string is a typed list, as in `--currencies USD,EUR` or
 * `--currencies asia`: codes and set names, in any case.
 */
export function resolveCurrencies(saved?: unknown): FxCurrency[] {
  const codes: readonly unknown[] = typeof saved === "string"
    ? saved.split(/[\s,]+/).flatMap((token): readonly string[] => (
      CURRENCY_SETS.find((set) => set.id === token.toLowerCase())?.currencies ?? [token.toUpperCase()]
    ))
    : Array.isArray(saved) ? saved : [];
  const resolved = [...new Set(codes.filter(isFxCurrency))];
  return resolved.length > 0 ? resolved : [...MAJOR_CURRENCIES];
}
