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

/** Listings named for a word that names several companies, at most this many of them. */
const MAX_NAME_MATCHES = 5;

/** Kana: a name written with any is written the Japanese way, which a Chinese short name never is. */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** A name as it is compared: full-width letters folded, spaces and the middle dot gone (ソニー・グループ is ソニーグループ). */
function nameKey(text: string): string {
  return foldTypedText(text).replace(/[\s・･]+/g, "").toUpperCase();
}

/**
 * What a word typed in Japanese was read as: the listings it names (at most
 * `MAX_NAME_MATCHES`, the major companies first), how many companies it names
 * in all, and how: a market's word, a company's whole name, the start of the
 * names, or a word within them.
 */
export interface JapaneseNameReading {
  listings: JapaneseNameListing[];
  total: number;
  match: "market" | "name" | "start" | "within";
}

interface ListedName {
  key: string;
  name: string;
  folded: string;
}

let names: Promise<readonly ListedName[]> | null = null;
let major: Promise<ReadonlySet<string>> | null = null;

/** The Tokyo codes among the major listings that ship with the app: a name several companies start with lists theirs first. */
function majorTokyoCodes(): Promise<ReadonlySet<string>> {
  major ??= import("./major-listings.chunk.js").then(({ MAJOR_LISTINGS }) => new Set(MAJOR_LISTINGS
    .filter(([, , exchange]) => exchange === "JPX").map(([symbol]) => symbol)));
  return major;
}

/**
 * The Tokyo listings' Japanese names (`bun run japanese-names:snapshot`), each
 * with the form it is compared in, read and folded once, the first time a name
 * in Japanese is.
 */
function japaneseNames(): Promise<readonly ListedName[]> {
  names ??= import("./japanese-names.json").then((snapshot) => (snapshot.default.names as unknown as ReadonlyArray<readonly [string, string]>)
    .map(([code, name]) => ({ key: `${code}:JPX`, name, folded: nameKey(name) })));
  return names;
}

/** The listings found, the major companies first (トヨタ is Toyota Motor before Toyota Boshoku), else in code order. */
async function reading(found: readonly ListedName[], match: JapaneseNameReading["match"]): Promise<JapaneseNameReading | null> {
  if (found.length === 0) return null;
  const majors = found.length > 1 ? await majorTokyoCodes() : new Set<string>();
  const isMajor = (key: string) => majors.has(key.slice(0, -":JPX".length));
  const listings = [...found].sort((left, right) => Number(isMajor(right.key)) - Number(isMajor(left.key)))
    .slice(0, MAX_NAME_MATCHES).map(({ key, name }) => ({ key, name }));
  return { listings, total: found.length, match };
}

/** A market's word (ドル円, 日経平均, 金), in whatever script: the listing that quotes it. */
function marketWord(typed: string): JapaneseNameReading | null {
  const market = MARKET_WORDS[foldTypedText(typed).replace(/[\s・･]+/g, "")];
  return market ? { listings: [{ key: market, name: typed.trim() }], total: 1, match: "market" } : null;
}

/**
 * What a word typed in Japanese names: a market's word (ドル円 is USDJPY=X,
 * 日経平均 ^N225, 金 GC=F), else, for a word with kana, the Tokyo listing
 * whose company has that name (トヨタ自動車 is 7203:JPX), else those whose
 * company's name starts with it (トヨタ: Toyota Motor and Toyota Boshoku),
 * then those that hold it. Null for a word in Latin letters, one no name
 * holds, and a word in kanji alone, which is as likely a Chinese short name
 * (中電 is CLP in Hong Kong, not Chudenko): the service is asked about that
 * first, and `readExactJapaneseName` only when it finds nothing.
 */
export async function readJapaneseName(typed: string): Promise<JapaneseNameReading | null> {
  const word = nameKey(typed);
  if (!word || !hasNonLatinLetters(word)) return null;
  const market = marketWord(typed);
  if (market) return market;
  if (!KANA.test(word)) return null;
  const listed = await japaneseNames();
  return await reading(listed.filter((entry) => entry.folded === word), "name")
    ?? await reading(listed.filter((entry) => entry.folded.startsWith(word)), "start")
    ?? await reading(listed.filter((entry) => entry.folded.includes(word)), "within");
}

/**
 * The Tokyo listing a word in kanji alone is the whole name of (中電工 is
 * 1941:JPX), for when the service finds nothing for it; never the names it
 * starts or is within. Null for any other word.
 */
export async function readExactJapaneseName(typed: string): Promise<JapaneseNameReading | null> {
  const word = nameKey(typed);
  if (!word || !hasNonLatinLetters(word) || KANA.test(word)) return null;
  return await reading((await japaneseNames()).filter((entry) => entry.folded === word), "name");
}

/** Whether a word is in kanji alone, so the service reads it first (`readJapaneseName`). */
export function isKanjiOnlyName(typed: string): boolean {
  const word = nameKey(typed);
  return !!word && hasNonLatinLetters(word) && !KANA.test(word) && !marketWord(typed);
}

/** "Read "トヨタ" as 7203:JPX (トヨタ自動車), 3116:JPX (トヨタ紡織)." naming each listing a word in Japanese was read as. */
export function japaneseNameReadAs(typed: string, { listings, total, match }: JapaneseNameReading): string {
  const named = listings.map(({ key, name }) => name === typed.trim() ? key : `${key} (${name})`);
  const shown = total > listings.length ? ` (${listings.length} of ${namesCount(typed, total, match)})` : "";
  return `Read "${typed.trim()}" as ${named.join(", ")}${shown}.`;
}

/**
 * "126 companies start with 日本. Listings: ...": a word that names several
 * companies, for a command that takes one listing, with the real count.
 */
export function japaneseNameChoice(typed: string, { listings, total, match }: JapaneseNameReading): string {
  const shown = total > listings.length ? `The first ${listings.length}` : "Listings";
  return `${namesCount(typed, total, match)}. ${shown}: ${listings.map(({ key, name }) => `${key} (${name})`).join(", ")}.`;
}

function namesCount(typed: string, total: number, match: JapaneseNameReading["match"]): string {
  const word = typed.trim();
  return match === "start" ? `${total} companies start with ${word}`
    : match === "within" ? `${total} companies' names hold ${word}`
    : `${word} names ${total} companies`;
}
