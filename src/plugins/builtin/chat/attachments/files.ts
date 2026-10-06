import type { ChatAttachmentUpload } from "../../../../api-client";
import { MAX_CHAT_IMAGE_BYTES, sniffChatImageType } from "./model";

type NodeFs = typeof import("fs/promises");

/** Loaded at run time, so the web and desktop view bundles never pull in Node modules. */
async function nodeModules(): Promise<{ fs: NodeFs; homedir: () => string; basename: (path: string) => string }> {
  const fsModulePath = "fs/promises";
  const osModulePath = "os";
  const pathModulePath = "path";
  const [fs, os, path] = await Promise.all([
    import(fsModulePath) as Promise<NodeFs>,
    import(osModulePath) as Promise<typeof import("os")>,
    import(pathModulePath) as Promise<typeof import("path")>,
  ]);
  return { fs, homedir: os.homedir, basename: path.basename };
}

/**
 * Reads image files the terminal composer was handed as paths. A path that
 * is no file is skipped, so a pasted path-like string stays text; a file too
 * large or not an image is still returned, for the upload checks to report.
 */
export async function readChatImageFiles(paths: string[]): Promise<ChatAttachmentUpload[]> {
  const { fs, homedir, basename } = await nodeModules();
  const uploads: ChatAttachmentUpload[] = [];
  for (const rawPath of paths) {
    const path = rawPath.startsWith("~/") ? `${homedir()}${rawPath.slice(1)}` : rawPath;
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile()) continue;
      const name = basename(path);
      if (stat.size > MAX_CHAT_IMAGE_BYTES) {
        // Not read: the size alone is the answer, and the upload checks refuse it before any upload.
        uploads.push({ name, type: "", data: { size: stat.size } as unknown as Blob });
        continue;
      }
      const data = new Uint8Array(await fs.readFile(path));
      uploads.push({ name, type: sniffChatImageType(data) ?? "application/x-unknown", data });
    } catch {
      // Missing or unreadable: the paste stays text.
    }
  }
  return uploads;
}
