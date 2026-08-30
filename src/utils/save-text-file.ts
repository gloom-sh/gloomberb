import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

function safeFilename(name: string): string {
  const safe = basename(name.replace(/\\/g, "/"))
    .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "");
  return !safe || safe === "." || safe === ".." ? "gloomberb-export.txt" : safe;
}

export async function saveTextFileToDirectory(
  directory: string,
  name: string,
  text: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const safeName = safeFilename(name);
  const extension = extname(safeName);
  const stem = safeName.slice(0, safeName.length - extension.length);

  for (let copy = 1; ; copy += 1) {
    const filename = copy === 1 ? safeName : `${stem} (${copy})${extension}`;
    try {
      await writeFile(join(directory, filename), text, { encoding: "utf-8", flag: "wx" });
      return filename;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function saveTextFileToDownloads(name: string, text: string): Promise<string> {
  const filename = await saveTextFileToDirectory(join(homedir(), "Downloads"), name, text);
  return `~/Downloads/${filename}`;
}
