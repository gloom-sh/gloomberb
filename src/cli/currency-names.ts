/**
 * Currencies by the names people give them (`peso`, `Swiss franc`, `rand`),
 * for `fx`, which takes ISO codes. Each currency lists its names, the first
 * one saying whose it is. The last word of every name is also the generic
 * word for it (`peso` for the Mexican peso), shared by every currency that
 * uses it, so a word several currencies carry names all of them, most traded
 * first.
 */
const CURRENCY_NAMES: ReadonlyArray<readonly [code: string, ...names: string[]]> = [
  ["MXN", "Mexican peso"],
  ["ARS", "Argentine peso"],
  ["COP", "Colombian peso"],
  ["CLP", "Chilean peso"],
  ["PHP", "Philippine peso"],
  ["UYU", "Uruguayan peso"],
  ["DOP", "Dominican peso"],
  ["USD", "US dollar", "United States dollar", "American dollar"],
  ["CAD", "Canadian dollar"],
  ["AUD", "Australian dollar"],
  ["NZD", "New Zealand dollar"],
  ["HKD", "Hong Kong dollar"],
  ["SGD", "Singapore dollar"],
  ["TWD", "Taiwan dollar"],
  ["EUR", "euro"],
  ["GBP", "British pound", "pound sterling"],
  ["EGP", "Egyptian pound"],
  ["JPY", "Japanese yen", "yen"],
  ["CNY", "Chinese yuan", "yuan", "renminbi", "rmb"],
  ["CHF", "Swiss franc"],
  ["XOF", "West African CFA franc"],
  ["XAF", "Central African CFA franc"],
  ["INR", "Indian rupee"],
  ["PKR", "Pakistani rupee"],
  ["LKR", "Sri Lankan rupee"],
  ["NPR", "Nepalese rupee"],
  ["IDR", "Indonesian rupiah"],
  ["KRW", "South Korean won", "Korean won", "won"],
  ["BRL", "Brazilian real", "Brazilian reais", "reais"],
  ["ZAR", "South African rand"],
  ["TRY", "Turkish lira"],
  ["NOK", "Norwegian krone", "Norwegian kroner"],
  ["DKK", "Danish krone", "Danish kroner"],
  ["SEK", "Swedish krona", "Swedish kronor"],
  ["ISK", "Icelandic krona", "Icelandic kronur"],
  ["CZK", "Czech koruna", "Czech crown"],
  ["PLN", "Polish zloty", "Polish zlotych"],
  ["HUF", "Hungarian forint"],
  ["RON", "Romanian leu", "Romanian lei"],
  ["BGN", "Bulgarian lev", "Bulgarian leva"],
  ["RUB", "Russian ruble", "Russian rouble"],
  ["UAH", "Ukrainian hryvnia"],
  ["ILS", "Israeli shekel", "new shekel"],
  ["THB", "Thai baht"],
  ["VND", "Vietnamese dong"],
  ["MYR", "Malaysian ringgit"],
  ["BDT", "Bangladeshi taka"],
  ["NGN", "Nigerian naira"],
  ["GHS", "Ghanaian cedi"],
  ["KES", "Kenyan shilling"],
  ["UGX", "Ugandan shilling"],
  ["TZS", "Tanzanian shilling"],
  ["AED", "UAE dirham", "Emirati dirham"],
  ["MAD", "Moroccan dirham"],
  ["SAR", "Saudi riyal", "Saudi rial"],
  ["QAR", "Qatari riyal", "Qatari rial"],
  ["OMR", "Omani rial", "Omani riyal"],
  ["IRR", "Iranian rial", "Iranian riyal"],
  ["KWD", "Kuwaiti dinar"],
  ["BHD", "Bahraini dinar"],
  ["JOD", "Jordanian dinar"],
  ["IQD", "Iraqi dinar"],
  ["RSD", "Serbian dinar"],
  ["DZD", "Algerian dinar"],
  ["TND", "Tunisian dinar"],
  ["LYD", "Libyan dinar"],
  ["KZT", "Kazakhstani tenge"],
  ["PEN", "Peruvian sol"],
];

/** One currency a name stands for. */
export interface NamedCurrency {
  code: string;
  /** What tells it from the others that share the word: "Mexican" for peso. Empty when the name is the whole name. */
  qualifier: string;
}

/** The text of a name as it is looked up: lower case, without accents, punctuation or "the". */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/^the /, "");
}

let index: ReadonlyMap<string, readonly NamedCurrency[]> | undefined;

function nameIndex(): ReadonlyMap<string, readonly NamedCurrency[]> {
  if (index) return index;
  const built = new Map<string, NamedCurrency[]>();
  const add = (key: string, entry: NamedCurrency) => {
    const found = built.get(key);
    if (!found) built.set(key, [entry]);
    else if (!found.some((other) => other.code === entry.code)) found.push(entry);
  };
  for (const [code, ...names] of CURRENCY_NAMES) {
    for (const name of names) {
      const words = normalize(name).split(" ");
      const generic = words.at(-1)!;
      // "Mexican" for "Mexican peso"; the whole name when it is one word, which says no more than the word.
      const qualifier = words.length > 1 ? name.slice(0, name.length - generic.length).trim() : "";
      add(normalize(name), { code, qualifier: "" });
      add(generic, { code, qualifier });
    }
  }
  index = built;
  return built;
}

/**
 * The currencies a name stands for: `Swiss franc` is CHF alone, `peso` is
 * MXN, ARS, COP, CLP, PHP and more. A plural is its singular (`pesos`). Empty
 * for text that names no currency.
 */
export function currenciesNamed(text: string): readonly NamedCurrency[] {
  const key = normalize(text);
  const names = nameIndex();
  if (!key) return [];
  return names.get(key) ?? (key.endsWith("s") ? names.get(key.slice(0, -1)) : undefined) ?? [];
}
