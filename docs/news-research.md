# News research

News feeds and story detail use the source's story ID. A detail response with a different ID is rejected and the next configured source is tried. Story source failures appear in the existing pane footer; the available headline and summary remain readable. Returning to the list and reopening a story retries an unavailable detail request.

A refreshed story replaces the earlier headline and timeline when its publication time, headline, summary, URL, source or supplied timeline changes. A corrected URL retains one row for the same story ID. Unchanged feed summaries retain their loaded timeline. A detail response older than the current headline cannot replace its headline, summary or update time. A newer configured detail source is preferred; otherwise explicitly dated historical timeline items remain available beneath the current headline. A pending detail request for an earlier feed revision cannot overwrite the updated story. Multiple feed entries for the same story ID are ordered by publication time before importance; ranking across distinct stories still uses the selected table sort.

A Gloom Cloud news list's footer labels it from the answer it came from, not from the plan the app remembers. `real-time news` means the answer holds a story the service saw within the last 11 hours, which the 12-hour hold-back for free accounts never returns (the hour less leaves room for the two clocks to disagree). An answer to a request that carried no session is held back, and the footer shows the 12 h clock. An answer that shows neither, such as a quiet ticker's feed, keeps the 12 h clock and the upgrade on a free account and carries no label on a Pro one. A server that says which tier answered is believed over both rules. Restoring the saved session at launch, signing in or out and changing plan read every open news list again, and the new answer replaces its stories instead of mixing the two feeds.

A headline, source timestamp and available timeline are source reports, not a guarantee of complete event coverage. The terminal does not infer omitted updates, verify an issuer's transaction terms or backfill source outages. Use the existing Open action to inspect the original publication. News coverage, article-text availability and source timing vary by provider and access plan.

Atom feeds use the publisher's stable entry ID, and the feed timestamp reflects its `updated` value when supplied (otherwise `published`). The existing Open action uses the entry's alternate article link, preferring HTML, with relative links resolved through `xml:base` and the configured feed URL. Source/feed metadata nested within an entry does not replace the entry's own fields. These conventions follow [Atom's entry identity, link and update definitions](https://www.rfc-editor.org/rfc/rfc4287).

A failed or malformed RSS/Atom response leaves the last successfully cached stories available and reports the feed failure in the existing status bar. Other available feeds continue to contribute stories; successful recovery clears the failure. An empty, valid feed differs from an invalid document. The reader does not resolve external DTDs or expand custom entity declarations; documents requiring internal DTD subsets are unsupported. The parser cache version changes with this correction, so old cached article links and IDs are refetched rather than reused. The legacy array-only `fetchNews` capability preserves available articles; use `fetchNewsPage` for its source-failure status.

If saved news feed settings contain unreadable JSON, the News Feed status reports that the settings could not be read. RSS loading and feed edits pause, including automatic migration; the saved values stay untouched. Repair the affected `feeds` or `disabledDefaultFeedIds` value in the `news` plugin configuration and refresh to resume. To discard a damaged value deliberately, back up the configuration first, then replace that value with `[]`: this removes custom feeds for `feeds`, or restores bundled feeds for `disabledDefaultFeedIds`. Readable settings keep their existing normalization and migration behavior.

`gloom rss fetch <url>` exits with a non-zero status when the feed cannot be fetched or parsed. A valid feed with no items still succeeds; text output says "The feed has no items."

## Sources, times, tickers and topics

The SOURCE column names the publisher of the story's lead article as a reader knows it: FT, Reuters, Business Wire, the SEC for an 8-K, an X account as its handle. A story often merges the same event from several outlets; its detail lists each one. Times are in your local time: the clock time today, the weekday and time for the six days before, and the date for anything older.

A story shows a ticker when the story itself names the company, by name, brand or acronym (CIBC, Google for Alphabet) or by its ticker as a cashtag, an exchange pair or in brackets. A bare ticker counts only when it is not also a common word, and never inside a headline written in capitals. A company named only in one merged article, or only quoted on the economy ("Goldman expects..."), is left off the row but the story still appears in that company's ticker news. One listing is shown per company. Tickers from your own RSS feeds follow the same idea: one and two letter tickers need a cashtag, an exchange pair or brackets.

`NI` codes are assigned from each story's category, the wire it came from, its sectors and the words in its headline and summary: `MNA` for deals, `CB` for central banks and rate decisions, `ENERGY` for oil, gas and power across every sector, `REG` for regulators and regulation, `CRYPTO`, `EARN` for results and guidance, `IPO` for listings. A story can carry several codes. The sector codes filter by the story's sectors.

### Letters: `NI LTR`

`NI LTR` is the one code that lists no stories. It lists public fund and investor letters as links, newest first, for the last 12 months: manager commentaries and memos, company shareholder letters and annual reports to shareholders. A row shows the date, its basis, who wrote it, the title and the kind; Enter or a click opens the publisher's own page.

The Kind filter opens on All but annual reports: shareholder letters, memos and commentary. The other choices are Shareholder letters, Memos, Commentary, Annual reports and Everything; clear returns to the default.

The Date basis column says what each date is:

- Published: the date the publisher states.
- Filed: the EDGAR filing date.
- File updated: the last change of the document file, which is all some publishers' pages give. It is not when the letter came out, and is shown dimmer. A letter whose file carries no usable date is left out.

Only those facts and the link are kept, never the letter's text or a summary of it, and the list is not ranked. It needs no account. Annual reports come from SEC filings, up to five a day for companies with a ticker, and not every one contains a letter from the chief executive.

## Filtering, mutes and pop-out

`/` filters the stories a news list has loaded, by headline, source, summary, ticker and topic; a story has to contain every word typed. It does not search older stories the list has not loaded yet: clear the filter and scroll to load them.

Source and keyword mutes sit in the pane settings of News Feed, Topic News and Ticker News, and are shared by all three. A muted source hides the stories whose SOURCE is that publisher; a muted keyword hides the stories whose headline contains it, with several keywords separated by commas. Like the filter, mutes work on the stories the list has loaded, and a list whose loaded stories are all muted says so rather than reporting no news. Top News, Breaking News and breaking-news notifications ignore them.

`p` opens the selected story, or the one being read, in a pane of its own. That pane keeps a copy of the story, so it still shows after a restart, also for a story from one of your RSS feeds.

## Stories and filings in the command bar

Three or more letters typed in the command bar also look for news. Signed in, the News section searches the Gloom Cloud document index, as it always has. Signed out, it searches the stories the app has loaded: the latest feed (loaded for the lookup if no News Feed is open, with the same delay as News Feed) plus any other news list you have open. Each word has to start a word of the headline, summary or source, or a ticker, so `hor` finds Hormuz but not "author". Enter opens the story in its own pane.

A ticker with a form or the word filings, such as `AAPL 10-K`, `10-Q MSFT` or `NVDA filings`, lists that issuer's latest matching filings in a Filings section; without a form it lists the reports (10-K, 10-Q, 8-K, 20-F, 40-F, 6-K, S-1, DEF 14A) and leaves out ownership and sale notices. The lookup reads the issuer's 200 most recent filings, the same Gloom Cloud SEC list the SEC pane uses, so an issuer that files hundreds of notes a month can show no older report; `SEC AAPL` lists everything. Enter opens the SEC pane on that filing. A bare ticker does not look up filings.
