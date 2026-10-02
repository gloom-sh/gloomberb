/** Feed id words that name a section or a feed, never the publisher. */
const SECTION_WORDS = new Set([
  "all", "articles", "business", "companies", "current", "economy", "feed", "latest",
  "markets", "news", "press", "public", "releases", "rss", "stories", "top", "topstories", "world",
]);

/**
 * A publisher to show for a source id the service did not name (a service
 * from before publishers): "acme-wire-news" reads "Acme Wire", "x-some_handle"
 * reads "@some_handle", ids of three letters or fewer are acronyms (FT, SEC).
 * A name that already reads as one is kept.
 */
export function readableNewsSource(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /\s|[A-Z]/.test(trimmed) || trimmed.includes(".")) return trimmed;
  const words = trimmed.toLowerCase().split(/[-_]+/).filter(Boolean);
  if (words[0] === "x" && words.length > 1) return `@${words.slice(1).join("_")}`;
  const kept = words.filter((word) => !SECTION_WORDS.has(word));
  return (kept.length > 0 ? kept : words)
    .map((word) => (word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
