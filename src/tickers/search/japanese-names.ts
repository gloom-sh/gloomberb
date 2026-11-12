import { foldTypedText, hasNonLatinLetters } from "../../utils/typed-text";

/** A listing a name typed in Japanese reads as: its key, and the name it was found by. */
export interface JapaneseNameListing {
  key: string;
  name: string;
}

/**
 * Markets named in Japanese the way a trader in Tokyo types them, which no
 * company list holds: the yen crosses, the indices and the commodities, each
 * as the listing that quotes it here. TOPIX and the Nikkei VI are not quoted
 * (JPX and Nikkei license them), so they are left out rather than read as
 * something else.
 */
const MARKET_WORDS: Record<string, string> = {
  ドル円: "USDJPY=X", 米ドル円: "USDJPY=X",
  ユーロ円: "EURJPY=X", ポンド円: "GBPJPY=X", 豪ドル円: "AUDJPY=X", スイスフラン円: "CHFJPY=X", フラン円: "CHFJPY=X",
  カナダドル円: "CADJPY=X", NZドル円: "NZDJPY=X", ユーロドル: "EURUSD=X", ポンドドル: "GBPUSD=X", 豪ドル米ドル: "AUDUSD=X",
  日経平均: "^N225", 日経平均株価: "^N225", 日経225: "^N225", ダウ: "^DJI", NYダウ: "^DJI", ダウ平均: "^DJI",
  ナスダック: "^IXIC", 米国債10年: "^TNX", 米10年債: "^TNX",
  金: "GC=F", 金先物: "GC=F", 銀: "SI=F", プラチナ: "PL=F", 原油: "CL=F", WTI原油: "CL=F", ブレント原油: "BZ=F",
  ビットコイン: "BTC-USD", イーサリアム: "ETH-USD",
};

/** Company names that start with a word, at most this many of them, for a word that is the start of several names. */
const MAX_NAME_MATCHES = 5;

/** A name as it is compared: full-width letters folded, spaces and the middle dot gone (ソニー・グループ is ソニーグループ). */
function nameKey(text: string): string {
  return foldTypedText(text).replace(/[\s・･]+/g, "").toUpperCase();
}

let names: Promise<ReadonlyArray<readonly [code: string, name: string]>> | null = null;
let major: Promise<ReadonlySet<string>> | null = null;

/** The Tokyo codes among the major listings that ship with the app: a name several companies start with lists theirs first. */
function majorTokyoCodes(): Promise<ReadonlySet<string>> {
  major ??= import("./major-listings.chunk").then(({ MAJOR_LISTINGS }) => new Set(MAJOR_LISTINGS
    .filter(([, , exchange]) => exchange === "JPX").map(([symbol]) => symbol)));
  return major;
}

/** The Tokyo listings' Japanese names (`bun run japanese-names:snapshot`), read the first time a name in Japanese is. */
function japaneseNames(): Promise<ReadonlyArray<readonly [string, string]>> {
  names ??= import("./japanese-names.json").then((snapshot) => snapshot.default.names as unknown as ReadonlyArray<readonly [string, string]>);
  return names;
}

/**
 * The listings a word typed in Japanese names: a market's word (ドル円 is
 * USDJPY=X, 日経平均 ^N225, 金 GC=F), else the Tokyo listing whose company
 * has that name (トヨタ自動車 is 7203:JPX), else those whose company's name
 * starts with it (トヨタ: Toyota Motor and Toyota Boshoku), then those that
 * hold it, a few at most. Empty for a word in Latin letters or one no name
 * holds.
 */
export async function readJapaneseName(typed: string): Promise<JapaneseNameListing[]> {
  const word = nameKey(typed);
  if (!word || !hasNonLatinLetters(word)) return [];
  const market = MARKET_WORDS[foldTypedText(typed).replace(/[\s・･]+/g, "")];
  if (market) return [{ key: market, name: typed.trim() }];
  const listed = (await japaneseNames()).map(([code, name]) => ({ key: `${code}:JPX`, name, folded: nameKey(name) }));
  const exact = listed.filter((entry) => entry.folded === word);
  const found = exact.length > 0 ? exact
    : [listed.filter((entry) => entry.folded.startsWith(word)), listed.filter((entry) => entry.folded.includes(word))].find((matches) => matches.length > 0) ?? [];
  // The major companies first (トヨタ is Toyota Motor before Toyota Boshoku), else in code order.
  const majors = found.length > 1 ? await majorTokyoCodes() : new Set<string>();
  const isMajor = (key: string) => majors.has(key.slice(0, -":JPX".length));
  return [...found].sort((left, right) => Number(isMajor(right.key)) - Number(isMajor(left.key)))
    .slice(0, MAX_NAME_MATCHES).map(({ key, name }) => ({ key, name }));
}

/** "Read "トヨタ" as 7203:JPX (トヨタ自動車)." naming each listing a word in Japanese was read as. */
export function japaneseNameReadAs(typed: string, listings: readonly JapaneseNameListing[]): string {
  const named = listings.map(({ key, name }) => name === typed.trim() ? key : `${key} (${name})`);
  return `Read "${typed.trim()}" as ${named.join(", ")}.`;
}
