import { describe, expect, test } from "bun:test";
import { parseRssFeedDocument, type RssFeedConfig } from "./parser";

const DEFAULT_CONFIG: RssFeedConfig = {
  id: "test-feed",
  url: "https://example.com/feed",
  name: "Test Feed",
  authority: 60,
  enabled: true,
};

const RSS2_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0">
<channel>
  <title>Test Feed</title>
  <item>
    <title>Fed holds rates steady</title>
    <link>https://example.com/fed-rates</link>
    <pubDate>Thu, 10 Apr 2026 14:30:00 GMT</pubDate>
    <description>&lt;p&gt;The Federal Reserve held rates steady at 4.25%.&lt;/p&gt;</description>
    <category>Economy</category>
  </item>
  <item>
    <title><![CDATA[NVIDIA beats Q1 estimates]]></title>
    <link>https://example.com/nvda-q1</link>
    <pubDate>Thu, 10 Apr 2026 10:00:00 GMT</pubDate>
    <description>NVIDIA reported strong earnings.</description>
  </item>
  <item>
    <title>Oil surges on OPEC cuts</title>
    <link>https://example.com/oil-opec</link>
    <pubDate>Thu, 10 Apr 2026 08:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Markets rally on trade deal</title>
    <link href="https://example.com/trade-deal"/>
    <published>2026-04-10T12:00:00Z</published>
    <summary>Global markets surged on news of a trade agreement.</summary>
  </entry>
</feed>`;

describe("parseRssFeedDocument", () => {
  test("parses RSS items with normalized text, categories, source, dates, and stable ids", () => {
    const items = parseRssFeedDocument(RSS2_FIXTURE, DEFAULT_CONFIG);
    const again = parseRssFeedDocument(RSS2_FIXTURE, DEFAULT_CONFIG);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: "Fed holds rates steady",
      url: "https://example.com/fed-rates",
      source: "Test Feed",
      categories: ["Economy"],
    });
    expect(items[0]!.publishedAt).toBeInstanceOf(Date);
    expect(items[0]!.publishedAt.getFullYear()).toBe(2026);
    expect(items[0]!.summary).toContain("Federal Reserve");
    expect(items[0]!.summary).not.toContain("<p>");
    expect(items[0]!.summary).not.toContain("&lt;");
    expect(items[1]!.title).toBe("NVIDIA beats Q1 estimates");
    expect(items[2]).toMatchObject({
      title: "Oil surges on OPEC cuts",
      summary: undefined,
    });
    expect(items[0]!.id).toBe(again[0]!.id);
  });

  test("parses Atom entries", () => {
    const items = parseRssFeedDocument(ATOM_FIXTURE, DEFAULT_CONFIG);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Markets rally on trade deal",
      url: "https://example.com/trade-deal",
    });
    expect(items[0]!.publishedAt).toBeInstanceOf(Date);
    expect(items[0]!.publishedAt.getMonth()).toBe(3);
    expect(items[0]!.summary).toContain("trade agreement");
  });

  test("rejects empty or invalid input", () => {
    expect(() => parseRssFeedDocument("", DEFAULT_CONFIG)).toThrow("Invalid or unsupported news feed.");
    expect(() => parseRssFeedDocument("not xml at all <<<", DEFAULT_CONFIG)).toThrow("Invalid or unsupported news feed.");
    expect(() => parseRssFeedDocument("   \n\t  ", DEFAULT_CONFIG)).toThrow("Invalid or unsupported news feed.");
  });

  test("truncates long summaries and accepts title-only items", () => {
    const longDesc = "x".repeat(400);
    const xml = `<rss version="2.0"><channel>
      <item>
        <title>Long item</title>
        <link>https://example.com/long</link>
        <pubDate>Thu, 10 Apr 2026 08:00:00 GMT</pubDate>
        <description>${longDesc}</description>
      </item>
      <item><title>Titleonly item</title></item>
    </channel></rss>`;
    const items = parseRssFeedDocument(xml, DEFAULT_CONFIG);

    expect(items).toHaveLength(2);
    expect(items[0]!.summary!.length).toBeLessThanOrEqual(301);
    expect(items[0]!.summary).toContain("…");
    expect(items[1]!.title).toBe("Titleonly item");
  });

  test("uses config category when the item has none", () => {
    const items = parseRssFeedDocument(RSS2_FIXTURE, { ...DEFAULT_CONFIG, category: "markets" });

    expect(items[1]!.categories).toContain("markets");
  });
});

test("Atom chooses direct alternate links with namespaces, bases, quotes and XML entities", () => {
  const xml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://example.com/research/">
    <!-- <entry><title>Commented story</title></entry> -->
    <a:entry xml:base='issuer/'>
      <a:source><a:title>Wrong feed title</a:title><a:link href="wrong"/><a:id>wrong-id</a:id></a:source>
      <a:title>Cash offer</a:title><a:id>urn:Case:42</a:id><a:updated>2026-09-12T13:00:00Z</a:updated>
      <a:link rel="self" href="api"/><a:link rel="enclosure" href="audio.mp3"/>
      <a:link rel="alternate" type="application/pdf" href="notice.pdf"/>
      <a:link xml:base='../deals/' type='text/html' href='42?a=1&amp;b=2'/>
    </a:entry></a:feed>`;
  expect(parseRssFeedDocument(xml, DEFAULT_CONFIG)).toMatchObject([{
    id: "atom:urn:Case:42", title: "Cash offer", url: "https://example.com/research/deals/42?a=1&b=2",
  }]);
  expect(parseRssFeedDocument(xml.replace("urn:Case:42", "urn:case:42"), DEFAULT_CONFIG)[0]!.id)
    .not.toBe(parseRssFeedDocument(xml, DEFAULT_CONFIG)[0]!.id);
});

test("Atom correction identity survives title and URL changes and uses publisher update time", () => {
  const xml = (title: string, url: string, time: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <id>urn:issuer:42</id><title>${title}</title><link href="${url}"/>
    <published>2026-09-11T08:00:00Z</published><updated>${time}</updated></entry></feed>`;
  const first = parseRssFeedDocument(xml("Offer agreed", "https://example.com/deal", "2026-09-12T12:00:00Z"), DEFAULT_CONFIG)[0]!;
  const next = parseRssFeedDocument(xml("Offer withdrawn", "https://example.com/withdrawal", "2026-09-12T13:00:00Z"), DEFAULT_CONFIG)[0]!;
  expect(next.id).toBe(first.id);
  expect(next.publishedAt.toISOString()).toBe("2026-09-12T13:00:00.000Z");
});

test("Atom text, HTML, XHTML and CDATA retain readable text without nested fake stories", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Revenue &lt; $10m &amp; cash &gt; $2m</title>
    <summary type="html">&lt;p&gt;Oil &amp;amp; gas&lt;/p&gt;</summary></entry>
    <entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Cash <b>offer</b> withdrawn</div></title>
    <content><![CDATA[<entry><title>Literal content only</title></entry>]]></content></entry></feed>`;
  const items = parseRssFeedDocument(xml, DEFAULT_CONFIG);
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ title: "Revenue < $10m & cash > $2m", summary: "Oil & gas" });
  expect(items[1]!.title).toBe("Cash offer withdrawn");
});

test("feed document failures differ from valid emptiness, and external DTDs are not resolved", () => {
  expect(parseRssFeedDocument('<feed xmlns="http://www.w3.org/2005/Atom"/>', DEFAULT_CONFIG)).toEqual([]);
  expect(parseRssFeedDocument('<rss><channel/></rss>', DEFAULT_CONFIG)).toEqual([]);
  for (const xml of ["", "<html><body>Proxy error</body></html>", "<feed><entry><title>Truncated</title></feed>",
    '<feed xmlns="urn:other"><entry><title>Foreign</title></entry></feed>']) {
    expect(() => parseRssFeedDocument(xml, DEFAULT_CONFIG)).toThrow("Invalid or unsupported news feed");
  }
  expect(parseRssFeedDocument('<!DOCTYPE rss SYSTEM "https://example.invalid/rss.dtd">' + RSS2_FIXTURE.replace('<?xml version="1.0"?>', ''), DEFAULT_CONFIG)).toHaveLength(3);
});

test("RSS items with attributes and RDF RSS retain the previously readable article fields", () => {
  expect(parseRssFeedDocument(RSS2_FIXTURE.replace('<item>', '<item xml:lang="en">'), DEFAULT_CONFIG)).toHaveLength(3);
  const rdf = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="https://example.com/feed"><title>Feed</title></channel><item rdf:about="https://example.com/item"><title>Issuer filing</title><link>https://example.com/item</link></item></rdf:RDF>';
  expect(parseRssFeedDocument(rdf, DEFAULT_CONFIG)).toMatchObject([{ title: "Issuer filing", url: "https://example.com/item" }]);
});

test("RSS comment and CDATA markup cannot create additional stories or replace item metadata", () => {
  const xml = `<rss><channel><!-- <item><title>Commented story</title></item> -->
    <item><description><![CDATA[<item><title>Example markup</title></item>]]></description>
      <title>Actual issuer update</title><link>https://example.com/update</link></item></channel></rss>`;
  expect(parseRssFeedDocument(xml, DEFAULT_CONFIG)).toMatchObject([{ title: "Actual issuer update", url: "https://example.com/update" }]);
  expect(parseRssFeedDocument(xml, DEFAULT_CONFIG)).toHaveLength(1);
});
