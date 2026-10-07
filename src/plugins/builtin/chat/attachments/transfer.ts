import type { ChatAttachmentUpload } from "../../../../api-client";

/** A picked, pasted or dropped file: a DOM `File`, typed by shape so the terminal build needs no DOM types. */
export interface TransferFile {
  name: string;
  type: string;
  size: number;
}

interface TransferItem {
  kind: string;
  type: string;
  getAsFile(): TransferFile | null;
}

/** The parts of a DOM `DataTransfer` that paste and drop read. */
export interface TransferData {
  files?: ArrayLike<TransferFile> | null;
  items?: ArrayLike<TransferItem> | null;
  types?: ArrayLike<string> | null;
  getData?(format: string): string;
}

function listOf<T>(value: ArrayLike<T> | null | undefined): T[] {
  return value ? Array.from(value) : [];
}

/** Every file a transfer carries. Browsers list them under `files`, some only under `items`. */
export function transferFiles(transfer: TransferData | null | undefined): TransferFile[] {
  if (!transfer) return [];
  const files = listOf(transfer.files);
  if (files.length > 0) return files;
  return listOf(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is TransferFile => !!file);
}

/** Whether a drag carries files, which is all a page may know before the drop. */
export function transferCarriesFiles(transfer: TransferData | null | undefined): boolean {
  return listOf(transfer?.types).includes("Files");
}

/**
 * The files a paste attaches, or null to let the text paste as usual. A
 * screenshot, a copied image or a file copied in a file manager attaches; a
 * copy that also has real text (cells from a spreadsheet, which come with a
 * picture of themselves) pastes its text. A file manager puts the file's name
 * on the clipboard as text, and that does not count.
 */
export function clipboardAttachments(transfer: TransferData | null | undefined): TransferFile[] | null {
  const files = transferFiles(transfer);
  if (files.length === 0) return null;
  const text = (transfer?.getData?.("text/plain") ?? "").trim();
  if (!text) return files;
  const names = new Set(files.map((file) => file.name));
  const onlyNames = text.split(/\r?\n/).every((line) => {
    const name = line.trim().split(/[\\/]/).pop() ?? "";
    return names.has(name);
  });
  return onlyNames ? files : null;
}

/** A DOM file as an upload. The file is a Blob, so its bytes are read only when it goes up. */
export function uploadFromTransferFile(file: TransferFile): ChatAttachmentUpload {
  return { name: file.name, type: file.type, data: file as unknown as Blob };
}

const IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/i;

function decodeFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    // file:///C:/x.png on Windows
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/**
 * Splits pasted text the way a shell would: quotes group, and outside them a
 * backslash escapes the next character, except in a Windows path (`C:\a.png`).
 */
function splitShellWords(text: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let inWord = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length && !/^[A-Za-z]:/.test(current)) {
      current += text[++index];
      inWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    current += char;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(current);
  return words;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * The image files a terminal paste names, or null when it is ordinary text.
 * Dropping a file on a terminal types its path, escaped or quoted the way the
 * terminal likes (`/a/My\ Shot.png`, `'/a/My Shot.png'`, `file:///a/x.png`);
 * every word must be such a path for the paste to count.
 */
export function pastedImagePaths(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const words = trimmed.includes("\n")
    ? trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .flatMap((line) => splitShellWords(line) ?? [line])
    : splitShellWords(trimmed);
  if (!words || words.length === 0) return null;
  const paths: string[] = [];
  for (const word of words) {
    const path = word.startsWith("file://") ? decodeFileUrl(word) : word;
    if (!path || !isAbsolutePath(path) || !IMAGE_PATH.test(path)) return null;
    paths.push(path);
  }
  return paths;
}

/**
 * The text a single edit added, when the edit only inserted (a paste or a
 * drop); null for typing over a selection or deleting.
 */
export function insertedText(previous: string, next: string): { start: number; text: string } | null {
  if (next.length <= previous.length) return null;
  let start = 0;
  while (start < previous.length && previous[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < previous.length - start
    && previous[previous.length - 1 - end] === next[next.length - 1 - end]
  ) end += 1;
  if (start + end !== previous.length) return null;
  return { start, text: next.slice(start, next.length - end) };
}
