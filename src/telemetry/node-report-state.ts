import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { makePrivateDirSync, writePrivateFileSync } from "../utils/private-files";

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

export function readSentMap(value: unknown): Record<string, number> {
  const sent: Record<string, number> = {};
  if (!value || typeof value !== "object") return sent;
  for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at)) sent[key] = at;
  }
  return sent;
}

export function createNodeReportStateStore<T>(options: {
  fileName: string;
  getDataDir(): string | null;
  empty: () => T;
  parse: (record: Record<string, unknown>) => T;
  privateFile: boolean;
}) {
  return {
    load: (): T => {
      const dir = options.getDataDir();
      const path = dir ? join(dir, options.fileName) : null;
      if (!path || !existsSync(path)) return options.empty();
      return options.parse(parseJsonObject(readFileSync(path, "utf-8")));
    },
    save: (state: T): void => {
      const dir = options.getDataDir();
      if (!dir) return;
      const path = join(dir, options.fileName);
      if (options.privateFile) {
        makePrivateDirSync(dir);
        writePrivateFileSync(path, JSON.stringify(state));
      } else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(state), "utf-8");
      }
    },
  };
}
