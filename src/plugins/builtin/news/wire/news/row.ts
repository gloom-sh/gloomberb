import { TextAttributes } from "../../../../../ui";
import type { MarketNewsItem } from "../../../../../types/news-source";
import { colors } from "../../../../../theme/colors";
import { formatFeedTime } from "../../../../../utils/datetime-format";
import { listedHeadline } from "../../../../../news/news-model";

/**
 * How a story reads in a row wherever stories are listed (the news tables, a
 * ticker overview's latest news): when it came out, dim; who published it,
 * muted; the headline in the text colour, bold until it is read.
 */

/** "Mon 09:10", or "Sep 18, 25" for a story from another year. */
export const NEWS_TIME_WIDTH = 10;
/** Publishers and X handles: "GlobeNewswire", "@unusual_whales". */
export const NEWS_SOURCE_WIDTH = 15;
/** Below this the headline takes room back from the other columns. */
export const MIN_HEADLINE_WIDTH = 40;

export interface NewsRowCell {
  text: string;
  color: string;
  attributes?: number;
}

/** A story out after a moment the list is pinned to reads muted and plain throughout. */
interface NewsRowTone {
  later?: boolean;
}

const tone = (color: string, { later = false }: NewsRowTone) => later ? colors.textMuted : color;

export function newsTimeCell(article: MarketNewsItem, options: NewsRowTone = {}): NewsRowCell {
  return { text: formatFeedTime(article.publishedAt), color: tone(colors.textDim, options) };
}

export function newsSourceCell(article: MarketNewsItem): NewsRowCell {
  return { text: article.source, color: colors.textMuted };
}

export function newsHeadlineCell(
  article: MarketNewsItem,
  { read = false, title, ...options }: NewsRowTone & { read?: boolean; title?: string } = {},
): NewsRowCell {
  return {
    // A row standing for a run of routine notices says how many after its headline.
    text: title ?? listedHeadline(article),
    color: tone(colors.text, options),
    attributes: options.later || read ? TextAttributes.NONE : TextAttributes.BOLD,
  };
}
