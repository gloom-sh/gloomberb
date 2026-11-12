import { displayWidth, truncateToDisplayWidth } from "./format";

/** Cuts to `width` characters behind one `…`, the mark every cut text ends with. */
export function truncateWithEllipsis(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "\u2026";
  return `${text.slice(0, width - 1).trimEnd()}\u2026`;
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

/**
 * Styled runs of text (a markdown line's bold, code and link segments) on
 * lines no wider than `width`, broken only at whitespace, as `wrapTextLines`
 * breaks plain text: the terminal's own word wrap also breaks after `.`, `(`,
 * `-` and `/`, which split a version as `(0.` / `20.0)` (review, 12 Nov 2026).
 * A word wider than a line is cut by cells. Each line keeps its segments'
 * fields; the space a line breaks at is dropped, an indent before the first
 * word is kept.
 */
export function wrapSegmentLines<T extends { text: string }>(segments: readonly T[], width: number): T[][] {
  const kept = segments.filter((segment) => segment.text.length > 0);
  const full = kept.map((segment) => segment.text).join("");
  if (width <= 0 || !/\S/.test(full)) return [kept];
  // Where each line of `full` starts and ends, in UTF-16 offsets.
  const ranges: Array<[number, number]> = [];
  let start = -1;
  let end = 0;
  let used = 0;
  const flush = () => {
    if (start >= 0) ranges.push([start, end]);
    start = -1;
    used = 0;
  };
  for (const match of full.matchAll(/\S+/g)) {
    const word = match[0];
    const at = match.index;
    const cells = displayWidth(word);
    // The first line keeps the indent before its first word.
    const gap = start >= 0 ? displayWidth(full.slice(end, at)) : ranges.length === 0 ? displayWidth(full.slice(0, at)) : 0;
    if (start >= 0 && used + gap + cells > width) {
      flush();
      if (cells <= width) {
        start = at;
        used = cells;
        end = at + word.length;
        continue;
      }
    } else if (cells <= width || (start < 0 && gap + cells <= width)) {
      if (start < 0) start = ranges.length === 0 ? 0 : at;
      used += gap + cells;
      end = at + word.length;
      continue;
    }
    // Wider than a line: whole lines of it, then the rest begins the next.
    flush();
    const pieces = splitLongTextSegmentByDisplayWidth(word, width);
    let offset = at;
    pieces.forEach((piece, index) => {
      start = offset;
      end = offset + piece.length;
      used = displayWidth(piece);
      offset = end;
      if (index < pieces.length - 1) flush();
    });
  }
  flush();
  return ranges.map(([from, to]) => {
    const line: T[] = [];
    let cursor = 0;
    for (const segment of kept) {
      const segmentStart = cursor;
      cursor += segment.text.length;
      const sliceFrom = Math.max(from, segmentStart);
      const sliceTo = Math.min(to, cursor);
      if (sliceTo > sliceFrom) line.push({ ...segment, text: segment.text.slice(sliceFrom - segmentStart, sliceTo - segmentStart) });
    }
    return line;
  });
}
