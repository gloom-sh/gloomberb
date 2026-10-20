import { futuresContractByCode, type FuturesContract } from "./futures-board";

/**
 * The names a reader types for the commodities on the futures board, by the
 * board code they trade under. A news search that names one ("arabica",
 * "sugar prices") offers the future's own news route (news KC=F), and a
 * future's news searches the stories of its commodity by the first name
 * listed for its code (KC=F reads "coffee"): news is filed under companies,
 * and the service matches the same names to the stories filed under each
 * future. Longer names win where one holds another ("soybean oil", "oil").
 */
const COMMODITY_NAMES: ReadonlyArray<readonly [name: string, code: string]> = [
  ["coffee", "KC"], ["arabica", "KC"],
  ["sugar", "SB"], ["cocoa", "CC"], ["cotton", "CT"], ["orange juice", "OJ"], ["lumber", "LBR"],
  ["wheat", "ZW"], ["wheat", "KE"], ["corn", "ZC"],
  ["soybeans", "ZS"], ["soybean", "ZS"], ["soy", "ZS"], ["soybean meal", "ZM"], ["soybean oil", "ZL"],
  ["live cattle", "LE"], ["cattle", "LE"], ["lean hogs", "HE"], ["hogs", "HE"],
  ["gold", "GC"], ["silver", "SI"], ["copper", "HG"], ["platinum", "PL"], ["palladium", "PA"],
  ["aluminum", "ALI"], ["aluminium", "ALI"],
  ["oil", "CL"], ["crude oil", "CL"], ["crude", "CL"], ["wti", "CL"], ["oil", "QM"], ["oil", "MCL"],
  ["brent", "BZ"], ["heating oil", "HO"], ["gasoline", "RB"],
  ["natural gas", "NG"], ["natgas", "NG"], ["natural gas", "QG"], ["natural gas", "MNG"], ["natural gas", "HH"],
];

const PHRASES = COMMODITY_NAMES.map(([name, code]) => ({ words: name.split(" "), code }))
  .sort((a, b) => b.words.length - a.words.length);

/** The words of a text as the service reads them: lower case, split on anything but letters and digits. */
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The first commodity a text names, as its future on the board: "arabica" and "sugar prices" name KC and SB. */
export function commodityNamedIn(text: string): FuturesContract | null {
  const typed = words(text);
  for (let index = 0; index < typed.length; index += 1) {
    const phrase = PHRASES.find((entry) => entry.words.every((word, offset) => typed[index + offset] === word));
    if (phrase) return futuresContractByCode(phrase.code);
  }
  return null;
}

/** The name a future's stories are searched by: coffee for KC=F, wheat for ZW=F and KE=F. Null for a future with no commodity name (indices, rates, currencies, TTF). */
export function commoditySearchName(contract: Pick<FuturesContract, "code">): string | null {
  return COMMODITY_NAMES.find(([, code]) => code === contract.code)?.[0] ?? null;
}
