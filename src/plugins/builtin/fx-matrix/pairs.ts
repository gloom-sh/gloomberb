import { MISSING_VALUE } from "../../../utils/format";
import { fxRateDigits } from "../../../utils/currency-pair";
import { WORD_CURRENCY_CODES } from "../../../utils/currency-names";

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

/**
 * The words a reader looks for the board by: the codes it carries (but those
 * that are English words) and the names of its currencies, so `catalog yen`,
 * `catalog chf` and `catalog "swiss franc"` find it. "cad" is a word too, yet
 * in a market catalog it is the loonie far more often than not, so it still
 * finds the board; only the fx line waits for CAD in capitals.
 */
export const FX_CURRENCY_KEYWORDS: readonly string[] = [
  ...FX_CURRENCIES.filter((code) => code === "CAD" || !WORD_CURRENCY_CODES.has(code)).map((code) => code.toLowerCase()),
  "dollar", "euro", "yen", "pound", "sterling", "franc", "swiss franc", "loonie", "aussie", "kiwi", "yuan", "renminbi",
  "krona", "krone", "won", "rupee", "rupiah", "ringgit", "baht", "peso", "rand", "lira", "zloty", "forint", "koruna", "shekel",
];

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
 * A cross at its pair's precision (`fxRateDigits`), as `fx` and `quote` print
 * it: a rate in yen from 1 up to three decimals, from 1000 up to two, from 50
 * up to three, from 1 up to five, and below 1 five significant digits (KRW/JPY
 * 0.10712, VND/GBP 0.000030400). `currency` is the one the rate is in, the
 * cross's quote currency. Decimals are counted at `referenceRate` (the cross at
 * a rate that holds still) when there is one, so a live rate ticking across a
 * power of ten, such as JPY/AUD near 0.0100, keeps its decimals.
 */
export function formatRate(rate: number, currency: string, referenceRate = rate): string {
  if (!Number.isFinite(rate) || rate <= 0) return MISSING_VALUE;
  const basis = Number.isFinite(referenceRate) && referenceRate > 0 ? referenceRate : rate;
  return rate.toFixed(fxRateDigits(currency, basis));
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
