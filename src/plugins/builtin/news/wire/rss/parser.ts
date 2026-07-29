import type { MarketNewsItem } from "../../../../../types/news-source";
import { decodeHtmlEntities } from "../../../../../utils/html-entities";
import { hashString } from "../hash";

export interface RssFeedConfig {
  id: string;
  url: string;
  name: string;
  category?: string;
  authority: number; // 0-100
  enabled: boolean;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function extractText(s: string): string {
  // Decode entities first so escaped HTML tags become real tags, then strip them
  return stripHtml(decodeHtmlEntities(stripCdata(s))).trim();
}

function getTagContent(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1]!.trim() : "";
}

function parseDate(s: string): Date {
  if (!s) return new Date(0);
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function extractAttr(tag: string, attr: string): string {
  const m = tag.match(new RegExp(`${attr}="([^"]*)"`, "i"));
  return m ? m[1]! : "";
}

function extractImageUrl(block: string): string | undefined {
  // media:content url="..." (common in RSS 2.0 with media namespace)
  const mediaContent = block.match(/<media:content[^>]+url="([^"]+)"[^>]*(?:medium="image"|type="image\/)/i);
  if (mediaContent) return mediaContent[1]!;

  // media:content without explicit type (take first one with a url)
  const mediaAny = block.match(/<media:content[^>]+url="([^"]+)"/i);
  if (mediaAny) return mediaAny[1]!;

  // media:thumbnail url="..."
  const mediaThumbnail = block.match(/<media:thumbnail[^>]+url="([^"]+)"/i);
  if (mediaThumbnail) return mediaThumbnail[1]!;

  // enclosure with image type
  const enclosure = block.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image\//i);
  if (enclosure) return enclosure[1]!;

  // img src inside description/content CDATA
  const imgSrc = block.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i);
  if (imgSrc) return imgSrc[1]!;

  return undefined;
}

function parseRss2Items(xml: string, config: RssFeedConfig): MarketNewsItem[] {
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const items: MarketNewsItem[] = [];
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1]!;

    const title = extractText(getTagContent(block, "title"));
    const url = extractText(getTagContent(block, "link"));
    const pubDateRaw = extractText(getTagContent(block, "pubDate"));
    const descRaw = getTagContent(block, "description");
    const desc = descRaw ? extractText(descRaw) : undefined;
    const categoryRaw = getTagContent(block, "category");
    const category = categoryRaw ? extractText(categoryRaw) : undefined;

    if (!title && !url) continue;

    const summary = desc
      ? desc.slice(0, 300) + (desc.length > 300 ? "…" : "")
      : undefined;

    const id = hashString(`${url}|${title}`);
    const publishedAt = parseDate(pubDateRaw);
    const categories = category ? [category] : config.category ? [config.category] : [];
    const imageUrl = extractImageUrl(block);

    items.push({
      id,
      title,
      url,
      source: config.name,
      publishedAt,
      summary,
      imageUrl,
      topic: categories[0] ?? "general",
      topics: categories,
      sectors: [],
      categories,
      tickers: [],
      scores: {
        importance: 0,
        urgency: 0,
        marketImpact: 0,
        novelty: 0,
        confidence: 0,
      },
      importance: 0,
      isBreaking: false,
      isDeveloping: false,
    });
  }

  return items;
}

function parseAtomEntries(xml: string, config: RssFeedConfig): MarketNewsItem[] {
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  const items: MarketNewsItem[] = [];
  let match: RegExpExecArray | null;

  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1]!;

    const title = extractText(getTagContent(block, "title"));

    // Atom <link href="..."/> or <link>...</link>
    const linkTagMatch = block.match(/<link([^>]*)>/i);
    let url = "";
    if (linkTagMatch) {
      const href = extractAttr(linkTagMatch[0]!, "href");
      if (href) {
        url = href;
      } else {
        url = extractText(getTagContent(block, "link"));
      }
    }

    const publishedRaw =
      extractText(getTagContent(block, "published")) ||
      extractText(getTagContent(block, "updated"));

    const summaryRaw = getTagContent(block, "summary") || getTagContent(block, "content");
    const summaryFull = summaryRaw ? extractText(summaryRaw) : undefined;
    const summary = summaryFull
      ? summaryFull.slice(0, 300) + (summaryFull.length > 300 ? "…" : "")
      : undefined;

    if (!title && !url) continue;

    const id = hashString(`${url}|${title}`);
    const publishedAt = parseDate(publishedRaw);
    const categories = config.category ? [config.category] : [];
    const imageUrl = extractImageUrl(block);

    items.push({
      id,
      title,
      url,
      source: config.name,
      publishedAt,
      summary,
      imageUrl,
      topic: categories[0] ?? "general",
      topics: categories,
      sectors: [],
      categories,
      tickers: [],
      scores: {
        importance: 0,
        urgency: 0,
        marketImpact: 0,
        novelty: 0,
        confidence: 0,
      },
      importance: 0,
      isBreaking: false,
      isDeveloping: false,
    });
  }

  return items;
}

export function parseRssFeed(xml: string, config: RssFeedConfig): MarketNewsItem[] {
  if (!xml || !xml.trim()) return [];

  try {
    const isAtom = /<feed\b/i.test(xml);
    if (isAtom) {
      return parseAtomEntries(xml, config);
    }
    return parseRss2Items(xml, config);
  } catch {
    return [];
  }
}
