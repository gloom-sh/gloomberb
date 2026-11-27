import type { ChatAttachmentUpload } from "../../../../api-client";
import { expandHomePath, loadNodeFileModules } from "../../../../utils/node-file-read";
import { MAX_CHAT_IMAGE_BYTES, sniffChatImageType } from "./model";

/**
 * Reads image files the terminal composer was handed as paths. A path that
 * is no file is skipped, so a pasted path-like string stays text; a file too
 * large or not an image is still returned, for the upload checks to report.
 */
export async function readChatImageFiles(paths: string[]): Promise<ChatAttachmentUpload[]> {
  const { fs, homedir, basename } = await loadNodeFileModules();
  const uploads: ChatAttachmentUpload[] = [];
  for (const rawPath of paths) {
    const path = expandHomePath(rawPath, homedir);
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
