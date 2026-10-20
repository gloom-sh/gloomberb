import { futuresContractByCode, type FuturesContract } from "./futures-board";

/**
 * The names a reader types for the commodities on the futures board, by the
 * board code they trade under. A news search that names one ("arabica",
 * "sugar prices") offers the future's own news route (news KC=F), and a
 * future's news searches the stories of its commodity by the first name
 * listed for its code (KC=F reads "coffee"): news is filed under companies,
 * and the service matches the same names to the stories filed under each
 * future. Longer names win where one holds another ("soybean oil", "oil"),
 * and a name in any of its forms counts (hogs, soybeans), as the service
 * reads it. A null code is an oil no future trades: "palm oil" is not crude.
 */
const COMMODITY_NAMES: ReadonlyArray<readonly [name: string, code: string | null]> = [
  ["coffee", "KC"], ["arabica", "KC"],
  ["sugar", "SB"], ["cocoa", "CC"], ["cotton", "CT"], ["orange juice", "OJ"], ["lumber", "LBR"],
  ["wheat", "ZW"], ["wheat", "KE"], ["corn", "ZC"],
  ["soybean", "ZS"], ["soy", "ZS"], ["soybean meal", "ZM"], ["soybean oil", "ZL"], ["soy oil", "ZL"],
  // Cattle finds the ranchers' and packers' stories "live cattle" misses; a bare "hog" finds Harley-Davidson (HOG).
  ["cattle", "LE"], ["live cattle", "LE"], ["lean hog", "HE"], ["hog", "HE"],
  ["gold", "GC"], ["silver", "SI"], ["copper", "HG"], ["platinum", "PL"], ["palladium", "PA"],
  ["aluminum", "ALI"], ["aluminium", "ALI"],
  ["oil", "CL"], ["crude oil", "CL"], ["crude", "CL"], ["wti", "CL"], ["oil", "QM"], ["oil", "MCL"],
  ["brent", "BZ"], ["heating oil", "HO"], ["gasoline", "RB"],
  ["natural gas", "NG"], ["natgas", "NG"], ["natural gas", "QG"], ["natural gas", "MNG"], ["natural gas", "HH"],
  ...["palm", "olive", "cooking", "vegetable", "corn", "edible", "sunflower", "canola", "rapeseed", "coconut", "peanut", "sesame",
    "avocado", "cottonseed", "linseed", "flaxseed", "fish", "castor", "essential", "hemp", "cbd", "motor", "engine",
    "lubricating", "baby", "snake"].map((kind) => [`${kind} oil`, null] as const),
];

/** Words that end in s without being plurals, as the service keeps them whole. */
const NOT_PLURAL = new Set(["news", "series", "species"]);

/**
 * A word and its simple singular or plural, as the service's search reads a
 * word: hogs and hog, soybeans and soybean, gases and gas.
 */
function wordForms(word: string): string[] {
  if (!/^\p{L}+$/u.test(word) || NOT_PLURAL.has(word)) return [word];
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) {
    const singulars = [word.slice(0, -1)];
    if (word.length > 4 && word.endsWith("ies")) singulars.push(`${word.slice(0, -3)}y`);
    else if (/(s|x|z|ch|sh)es$/.test(word)) singulars.push(word.slice(0, -2));
    return [word, ...singulars];
  }
  if (word.length < 3) return [word];
  const plural = /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`;
  return [word, plural];
}

const PHRASES = COMMODITY_NAMES.map(([name, code]) => ({ words: name.split(" "), code }))
  .sort((a, b) => b.words.length - a.words.length);

/** The words of a text as the service reads them: lower case, split on anything but letters and digits. */
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether the typed words are the name's, each in any of its forms. */
const sameWords = (typed: readonly string[], name: readonly string[]) => typed.length === name.length
  && name.every((word, index) => wordForms(typed[index]!).includes(word));

/** The first commodity a text names, as its future on the board: "arabica" and "sugar prices" name KC and SB; "palm oil" names none. */
export function commodityNamedIn(text: string): FuturesContract | null {
  const typed = words(text);
  for (let index = 0; index < typed.length;) {
    const phrase = PHRASES.find((entry) => sameWords(typed.slice(index, index + entry.words.length), entry.words));
    if (phrase?.code) return futuresContractByCode(phrase.code);
    index += phrase?.words.length ?? 1;
  }
  return null;
}

/** Whether the text is only a commodity's name, in any of its forms: "soybeans" searches what "soybean" does. */
export function isCommodityName(text: string, name: string): boolean {
  return sameWords(words(text), words(name));
}

/** The name a future's stories are searched by: coffee for KC=F, wheat for ZW=F and KE=F. Null for a future with no commodity name (indices, rates, currencies, TTF). */
export function commoditySearchName(contract: Pick<FuturesContract, "code">): string | null {
  return COMMODITY_NAMES.find(([, code]) => code === contract.code)?.[0] ?? null;
}
