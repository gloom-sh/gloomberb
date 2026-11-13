/**
 * Refreshes the Japanese company names that ship with the app,
 * `src/tickers/search/japanese-names.json`: `bun run japanese-names:snapshot`.
 * Search reads a name typed in Japanese (トヨタ, ソニーグループ) as the Tokyo
 * listings whose company it names, since listings are named in Latin letters.
 *
 * The names are the Japan Exchange Group's public list of the companies listed
 * on its markets (東証上場銘柄一覧, an Excel sheet it refreshes monthly): each
 * domestic or foreign stock's four-character code and its name in Japanese.
 * Funds, REITs and other products are left out: a name typed for them is in
 * Latin letters. Names are kept with full-width letters folded (Ｕｍｉｏｓ is
 * Umios), as search folds what is typed. `bun scripts/update-japanese-names.ts
 * <path> <fetched-at> <last-modified>` reads a copy already downloaded instead,
 * dated by when it was fetched and the Last-Modified it was served with.
 */
import { writeFile } from "fs/promises";
import { join } from "path";

const LIST_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx";
const SNAPSHOT_PATH = join(import.meta.dir, "..", "src", "tickers", "search", "japanese-names.json");

/** The market segments whose rows are companies: Prime, Standard and Growth, domestic and foreign. */
const STOCK_SEGMENT = /^(?:プライム|スタンダード|グロース)（(?:内国|外国)株式）$/;

/** Each file of a zip archive by name, inflated: an .xlsx is one. */
function unzip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let at = archive.length - 22; at >= 0; at -= 1) if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error("Not a zip archive: no end of central directory.");
  const files = new Map<string, Uint8Array>();
  let at = view.getUint32(end + 16, true);
  for (let entry = view.getUint16(end + 10, true); entry > 0; entry -= 1) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = archive.subarray(start, start + size);
    files.set(name, method === 8 ? Bun.inflateSync(new Uint8Array(data)) : data);
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return files;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

function xmlText(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_match, entity: string) => entity.startsWith("#")
    ? String.fromCodePoint(entity[1]!.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
    : XML_ENTITIES[entity.toLowerCase()]!);
}

/** The sheet's rows, each a column letter's text: shared strings resolved, numbers as written. */
function sheetRows(files: Map<string, Uint8Array>): Array<Record<string, string>> {
  const decode = (name: string) => new TextDecoder().decode(files.get(name) ?? new Uint8Array());
  const shared = [...decode("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(([, item]) => xmlText([...item!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, text]) => text).join("")));
  return [...decode("xl/worksheets/sheet1.xml").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(([, row]) => Object.fromEntries(
    [...row!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, column, attributes, body]) => {
      const value = /<v>([\s\S]*?)<\/v>/.exec(body ?? "")?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(body ?? "")?.[1] ?? "";
      return [column!, /t="s"/.test(attributes!) ? shared[Number(value)] ?? "" : xmlText(value)];
    }),
  ));
}

async function readList(path: string | undefined, fetched?: string, modified?: string): Promise<{ archive: Uint8Array; lastModified: string | null; fetchedAt: string }> {
  if (path) {
    return { archive: new Uint8Array(await Bun.file(path).arrayBuffer()), lastModified: modified ?? null,
      fetchedAt: fetched ? new Date(fetched).toISOString() : new Date().toISOString() };
  }
  const response = await fetch(LIST_URL);
  if (!response.ok) throw new Error(`${LIST_URL} answered ${response.status}.`);
  return {
    archive: new Uint8Array(await response.arrayBuffer()),
    lastModified: response.headers.get("last-modified"),
    fetchedAt: new Date().toISOString(),
  };
}

const { archive, lastModified, fetchedAt } = await readList(process.argv[2], process.argv[3], process.argv[4]);
const [header, ...rows] = sheetRows(unzip(archive));
const column = (title: string) => Object.entries(header ?? {}).find(([, text]) => text === title)?.[0];
const [code, name, segment, date] = ["コード", "銘柄名", "市場・商品区分", "日付"].map(column);
if (!code || !name || !segment) throw new Error("The list's header has no コード, 銘柄名 or 市場・商品区分 column.");
const names = rows
  .filter((row) => STOCK_SEGMENT.test(row[segment] ?? "") && /^[0-9A-Z]{4}$/.test(row[code] ?? ""))
  .map((row) => [row[code]!, row[name]!.normalize("NFKC").replace(/\s+/g, " ").trim()] as const)
  .sort(([left], [right]) => left.localeCompare(right));
// The list is dated by its own column: an Excel serial day, 20260930 or 2026-09-30.
const listed = date ? rows[0]?.[date] ?? "" : "";
const asOf = /^\d{8}$/.test(listed) ? `${listed.slice(0, 4)}-${listed.slice(4, 6)}-${listed.slice(6)}`
  : /^\d{5}$/.test(listed) ? new Date(Date.UTC(1899, 11, 30) + Number(listed) * 86_400_000).toISOString().slice(0, 10)
    : listed || null;
await writeFile(SNAPSHOT_PATH, `${JSON.stringify({
  source: LIST_URL,
  asOf,
  ...lastModified ? { lastModified: new Date(lastModified).toISOString() } : {},
  fetchedAt,
  names,
})}\n`);
console.log(`${names.length} names as of ${asOf ?? "an undated list"} written to ${SNAPSHOT_PATH}.`);
