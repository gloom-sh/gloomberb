import { decodeHtmlEntities } from "../../../utils/html-entities";

export function normalizeTweetText(
  value: string,
  options: { preserveLineBreaks?: boolean } = {},
): string {
  const decoded = decodeHtmlEntities(value).replace(/\r\n?/g, "\n");

  if (!options.preserveLineBreaks) {
    return decoded.replace(/\s+/g, " ").trim();
  }

  return decoded
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .trim();
}
