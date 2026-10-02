import type { MarketNewsItem } from "../../../../../types/news-source";
import { decodeHtmlEntities } from "../../../../../utils/html-entities";
import { hashString } from "../hash";
import { feedChildren, feedText, parseFeedXml, resolveFeedUrl, type FeedElement } from "./feed-xml";
import { isManagedNewsFeedUrl } from "./managed-feed";

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

function atomTextConstruct(node: FeedElement | undefined): string {
  const value = feedText(node);
  // Atom text is literal. HTML constructs encode markup; XHTML was parsed as
  // elements already. The same rules apply to article and origin titles.
  return node?.attributes.type === "html" ? decodeHtmlEntities(stripHtml(value)).trim() : value;
}

function parseDate(s: string): Date {
  if (!s) return new Date(0);
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date(0) : d;
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

function parseRssItems(xml: string, config: RssFeedConfig, root: FeedElement): MarketNewsItem[] {
  const entries = root.localName === "RDF"
    ? feedChildren(root, "item", "http://purl.org/rss/1.0/")
    : feedChildren(feedChildren(root, "channel")[0]!, "item");
  const items: MarketNewsItem[] = [];
  for (const entry of entries) {
    const block = xml.slice(entry.innerStart, entry.innerEnd);
    const tagContent = (name: string) => {
      const node = feedChildren(entry, name)[0];
      return node ? xml.slice(node.innerStart, node.innerEnd) : "";
    };

    const title = extractText(tagContent("title"));
    const url = extractText(tagContent("link"));
    const pubDateRaw = extractText(tagContent("pubDate"));
    const descRaw = tagContent("description");
    const desc = descRaw ? extractText(descRaw) : undefined;
    const categoryRaw = tagContent("category");
    const category = categoryRaw ? extractText(categoryRaw) : undefined;
    const publisher = extractText(tagContent("source"));

    if (!title && !url) continue;
    // Managed syndication must name the article's publisher. The feed's own
    // label describes a delivery service, not the author of an article.
    if (!publisher && isManagedNewsFeedUrl(config.url)) continue;

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
      source: publisher || config.name,
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

function parseAtomEntries(xml: string, config: RssFeedConfig, root: FeedElement): MarketNewsItem[] {
  return feedChildren(root, "entry").flatMap((entry): MarketNewsItem[] => {
    const text = (name: string) => feedText(feedChildren(entry, name)[0]);
    const construct = (name: string) => atomTextConstruct(feedChildren(entry, name)[0]);
    const title = construct("title");
    const origin = feedChildren(entry, "source")[0];
    const publisher = origin ? atomTextConstruct(feedChildren(origin, "title")[0]) : "";
    if (!publisher && isManagedNewsFeedUrl(config.url)) return [];
    const links = feedChildren(entry, "link")
      .filter((link) => !link.attributes.rel || link.attributes.rel === "alternate"
        || link.attributes.rel === "http://www.iana.org/assignments/relation/alternate")
      .map((link) => ({
        url: resolveFeedUrl(link.attributes.href ?? "", link.base),
        type: (link.attributes.type ?? "").split(";")[0]!.trim().toLowerCase(),
      }))
      .filter((link) => /^https?:\/\//i.test(link.url));
    const url = (links.find((link) => link.type === "text/html" || link.type === "application/xhtml+xml")
      ?? links.find((link) => !link.type) ?? links[0])?.url ?? "";
    if (!title && !url) return [];
    const summaryFull = construct("summary") || construct("content");
    const summary = summaryFull ? summaryFull.slice(0, 300) + (summaryFull.length > 300 ? "…" : "") : undefined;
    // An Atom id survives headline/URL corrections. Do not normalize its case,
    // resolve it as a relative URL, or replace it with the presentation link.
    const publisherId = text("id");
    const id = publisherId ? `atom:${publisherId}` : hashString(`${url}|${title}`);
    const publishedAt = parseDate(text("updated") || text("published"));
    const categories = config.category ? [config.category] : [];
    const imageUrl = extractImageUrl(xml.slice(entry.innerStart, entry.innerEnd));
    return [{
      id, title, url, source: publisher || config.name, publishedAt, summary, imageUrl,
      topic: categories[0] ?? "general", topics: categories, sectors: [], categories, tickers: [],
      scores: { importance: 0, urgency: 0, marketImpact: 0, novelty: 0, confidence: 0 },
      importance: 0, isBreaking: false, isDeveloping: false,
    }];
  });
}

// The source uses this strict entry point so a proxy error page or truncated
// document cannot replace the last successful feed with a fresh empty cache.
export function parseRssFeedDocument(xml: string, config: RssFeedConfig): MarketNewsItem[] {
  const root = parseFeedXml(xml, config.url);
  if (root?.localName === "feed" && (!root.namespace || root.namespace === "http://www.w3.org/2005/Atom")) {
    return parseAtomEntries(xml, config, root);
  }
  if (root?.localName === "rss" && !root.namespace && feedChildren(root, "channel").length === 1) {
    return parseRssItems(xml, config, root);
  }
  if (root?.localName === "RDF" && root.namespace === "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    && feedChildren(root, "channel", "http://purl.org/rss/1.0/").length === 1) {
    return parseRssItems(xml, config, root);
  }
  throw new Error("Invalid or unsupported news feed.");
}
