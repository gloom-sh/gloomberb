/**
 * Hosts the web build names without fetching them: pages a pane links to,
 * sources it credits, references inside libraries, and the defaults of
 * features the browser build leaves out.
 *
 * The bundle audit (`scripts/audit-web-bundle.ts`) fails on any other host the
 * shipped JavaScript names that the page cannot fetch, meaning a host that is
 * neither in the worker's `connect-src` nor on the plugin proxy's allowlist.
 * That is how a function calling a host nobody declared gets caught before it
 * ships as "Failed to fetch"; TheBuildout's API once did.
 *
 * Add a host here only when nothing in the web build fetches it. When
 * something does, declare it in the plugin's `hosts` and run
 * `bun run web:proxy-hosts`, or list it in `WEB_DIRECT_HOSTS`
 * (src/utils/plugin-proxy-hosts.ts) when it answers the terminal with CORS.
 * Matching is exact, so a link to `polymarket.com` says nothing about
 * `gamma-api.polymarket.com`.
 */
export const WEB_LINK_ONLY_HOSTS: ReadonlySet<string> = new Set([
  // Gloom's own: the web app reaches the API as same-origin `/api` through the worker.
  "api.gloom.sh",
  "term.gloom.sh",
  "x.com",
  "github.com",

  // Venue and source pages a pane links to or credits.
  "agsi.gie.eu",
  "app.pascal.trade",
  "crypto.com",
  "ember-energy.org",
  "en.wikipedia.org",
  "exchange.gemini.com",
  "fred.stlouisfed.org",
  "kalshi.com",
  "limitless.exchange",
  "polymarket.com",
  "polymarket.us",
  "thebuildout.ai",
  "www.bls.gov",
  "www.cboe.com",
  "www.cnn.com",
  "www.deribit.com",
  "www.eex.com",
  "www.eia.gov",
  "www.federalreserve.gov",
  "www.finra.org",
  "www.ibkrguides.com",
  "www.interactivebrokers.com",
  "www.nahb.org",
  "www.nasdaq.com",
  "www.sec.gov",
  "www.ssga.com",

  // Exchanges' announcement and filing pages, and published session calendars.
  "dart.fss.or.kr",
  "ir.theice.com",
  "live.euronext.com",
  "mops.twse.com.tw",
  "www.asx.com.au",
  "www.bseindia.com",
  "www.ibge.gov.br",
  "www.londonstockexchange.com",
  "www.nasdaqomxnordic.com",
  "www.nseindia.com",
  "www.nyse.com",
  "www.nzx.com",
  "www.release.tdnet.info",
  "www.sedarplus.ca",
  "www.set.or.th",
  "www.sgx.com",
  "www.tcmb.gov.tr",
  "www.unternehmensregister.de",
  "www1.hkexnews.hk",
  "www3.bcb.gov.br",

  // The desktop's default RSS feeds; the web build has no RSS (docs/browser.md).
  "feeds.a.dj.com",
  "feeds.bbci.co.uk",
  "feeds.content.dowjones.io",
  "search.cnbc.com",

  // Documentation and examples quoted in help text, and references inside libraries.
  "aomedia.org",
  "bun.sh",
  "example.com",
  "git-scm.com",
  "modelcontextprotocol.io",
  "react.dev",
]);
