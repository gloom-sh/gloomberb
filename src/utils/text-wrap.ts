import { displayWidth, truncateToDisplayWidth } from "./format";

export function truncateWithEllipsis(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

export function splitLongTextSegmentByDisplayWidth(value: string, lineWidth: number): string[] {
  if (displayWidth(value) <= lineWidth) return [value];

  const chunks: string[] = [];
  let current = "";
  for (const char of Array.from(value)) {
    const next = `${current}${char}`;
    if (current && displayWidth(next) > lineWidth) {
      chunks.push(current);
      current = char;
      continue;
    }
    current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function wrapTextLines(
  text: string,
  width: number,
  maxLines = Number.MAX_SAFE_INTEGER,
): string[] {
  if (width <= 0) return [];

  const paragraphs = text
    .split(/\r?\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim());
  const lines: string[] = [];

  const pushLine = (line: string) => {
    if (lines.length >= maxLines) return;
    lines.push(line);
  };

  for (
    let paragraphIndex = 0;
    paragraphIndex < paragraphs.length;
    paragraphIndex += 1
  ) {
    const paragraph = paragraphs[paragraphIndex]!;
    if (!paragraph) {
      pushLine("");
      continue;
    }

    let current = "";
    for (const rawWord of paragraph.split(" ")) {
      let word = rawWord;
      while (displayWidth(word) > width) {
        const available = current ? width - displayWidth(current) - 1 : width;
        if (available <= 0) {
          pushLine(current);
          current = "";
          continue;
        }
        if (displayWidth(word) <= available) break;
        const piece = splitLongTextSegmentByDisplayWidth(word, available)[0]!;
        if (current && displayWidth(piece) > available) {
          pushLine(current);
          current = "";
          continue;
        }
        word = word.slice(piece.length);
        pushLine(current ? `${current} ${piece}` : piece);
        current = "";
      }

      if (!current) {
        current = word;
        continue;
      }

      if (displayWidth(current) + 1 + displayWidth(word) <= width) {
        current = `${current} ${word}`;
      } else {
        pushLine(current);
        current = word;
      }
    }

    if (current) pushLine(current);
    if (paragraphIndex < paragraphs.length - 1) pushLine("");
    if (lines.length >= maxLines) break;
  }

  if (
    lines.length === maxLines &&
    paragraphs.join(" ").length > lines.join(" ").length
  ) {
    lines[maxLines - 1] = truncateToDisplayWidth(
      lines[maxLines - 1] ?? "",
      width,
    );
  }

  return lines;
}
