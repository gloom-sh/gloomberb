# Supply chain evidence (Pro)

`SPLC NVDA` (or `SUPPLY NVDA`) opens the supply chain for a ticker. Without an argument it uses the focused ticker. The pane follows linked tickers like other research functions. Free accounts receive three rows per role in each direction, including evidence; Pro receives the full stored dataset.

The **Table** has two directions. **NVDA says** reads statements attributed to NVIDIA. **Names NVDA** reads other companies' statements and other sources naming NVIDIA. Role and direction are relative to the company in the pane title: suppliers flow in, customers flow out. A reverse percentage belongs to the reporting company. Cirrus Logic reporting Apple as 91% of revenue means 91% of Cirrus Logic's revenue, not Apple's.

A strip under the view switch names the company and counts the disclosed counterparties per role; a free account sees how many of them are shown.

**Share** keeps the disclosed percentage and its denominator together, in words: `of FY revenue`, `of quarterly revenue`, `of receivables`, `of cost of sales`, or the segment it is scoped to (`of Compute & Networking revenue`). A reverse share names the reporting company (`of CRUS revenue`). The bar beside it draws the percentage on a 0 to 100% scale in the role's colour. A scoped percentage is not treated as a whole-company revenue percentage; the full scope is in evidence. **Value** appears when a row discloses an amount, retaining its native currency and scale. **368,079 JPY million** means 368,079 million yen. Sorting values groups currencies before comparing amounts within each currency. USD values remain separately marked **disclosed** or **≈ derived**; evidence retains both when present. Evidence tier and period accompany each relationship; a wide pane also shows publisher, publication date and independent origins. A narrow pane leaves the source detail to evidence. A missing number means it was not disclosed. Confidence describes extraction and entity resolution; it is not a probability of commercial success.

Customers the filer does not name are labelled **undisclosed customer** (or supplier), and geographic, channel and customer cohorts **customer group**, both in muted text so they never read as a company.

The **Evidence** filter defaults to Filings, Company and Call. Add Reported to see corroborated reporting. Add Unconfirmed to see rumors and single-source leads, including reported leads that still await verification. Unconfirmed rows occupy a separate section and do not enter flow diagrams or disclosed concentrations. A source's trust tier is distinct from the relationship role: a company announcement can describe an investment without establishing a supplier relationship.

| Tier | Evidence | Meaning |
| --- | --- | --- |
| 1 | Filings | Regulatory filing disclosure, including financial statements and filed text from the SEC and supported global filing sources |
| 2 | Company | Issuer press release, newsroom or IR announcement, including press-release exhibits |
| 3 | Call | Management statement in an earnings call; speech transcripts are identified in evidence |
| 4 | Reported | Reputable publisher reporting |
| 5 | Reported (trade) | Trade publication reporting |
| 6 | Unconfirmed | Rumor, social claim or other unverified lead |

Every relationship exposes the publisher, publication date and number of independent origins. A filing, press release and call from the same issuer share one origin; syndicated copies of an announcement do not establish independent corroboration. Unconfirmed details state why confirmation is missing. Expired and rejected leads are hidden. First seen, last seen and last confirmed dates describe discovery and verification, separately from publication and fiscal period. Superseded evidence remains visible in a relationship's source history.

Select a row and press **Enter** to open the counterparty's SPLC. **E** opens its evidence in the pane; **O** opens the source. **D**, **F** and **G** open that counterparty's description, financial analysis and chart. Unresolved and anonymous entities open evidence because they have no tradable ticker. **T** opens the independent TBO pane where available. Source links also work by mouse.

## Evidence and quoting

The evidence detail opens with share, value, period, publication date and confidence figures above the source history and quoted excerpts. It preserves the original-language quotation, any labelled English gloss, source link, date, publisher and confidence. A quoted span must match fetched source text after Unicode NFKC and whitespace normalization. Legacy filing evidence also displays its recorded match mode. Global filing evidence identifies the original quote's language, a separate **English gloss · machine translation** when available, the filing section and required source attribution. Only the original quote is evidence-validated; the gloss is a reading aid. EDINET attribution identifies EDINET and PDL1.0 and states that Gloom edited the extracted data. Confidence describes extraction and entity resolution; it is not a probability of commercial success.

Publisher articles whose quotation rights require review are **link only**. Their headline, publisher, date and source link are visible; article quotes and translated excerpts are absent from the pane, cache, screenshots and CLI output. Snippet-only material remains a lead and has no verified public quotation. Clear company releases, filings and calls can show short literal quotes. Source-native values preserve units and currency; gigawatts, unit counts, dollars and revenue shares are not interchangeable.

The table keeps a disclosed percentage and denominator together: revenue, receivables, cost or purchases. A scoped percentage spells out its denominator, with the full scope in evidence. Percentages are restricted to filing disclosures. Dollars are marked **disclosed** or **approximately derived**. Missing numbers mean the source did not disclose them. Source values from calls and announcements can appear in evidence but never set disclosed ribbon widths.

## Flow

**Flow** places suppliers to the left, the focus company in the middle and customers to the right. Each company is a card with its name, ticker and disclosed figure, edged in its role's colour; ribbons run from each card's edge to the focus company's edge and shade from one colour into the other. Partners, competitors and investees sit in a band underneath as ticker chips, one row per role, with cohort **Groups** listed as text beside them. Hover a card or ribbon to bring it forward and see the figure, its denominator, the period and the filing; Up/Down move the same highlight, and the selected relationship's filing and figure appear above the flow. Click a company or press Enter to open its own supply chain; an unresolved company opens evidence. More than the available space allows is grouped under **+N more**. Activating that node pages through the band without squeezing labels together. A narrow pane falls back to the table. The same Evidence filter governs both views.

Customer ribbon widths use tier-1 revenue percentages disclosed by the focus company for the same fiscal period and scope. The largest compatible group sets the scale, preferring whole-company revenue on a tie. Otherwise a column uses tier-1 disclosed or derived dollars. Native amounts are displayed with their currency and scale but do not introduce another ribbon weight or an implied exchange-rate conversion. A legend under the flow says what sets each column's widths. Known positive values appear first in descending order and are proportional, with a fixed scale across pages. Relationships with no comparable figure and company/call relationships are hairlines. Reported links are dashed. Unconfirmed leads have no node or ribbon. Reverse percentages and percentages with a different period, scope or denominator remain hairlines when revenue percentages set the scale. The columns scale independently. They are not an accounting identity, and no percentages are summed. The strongest eligible evidence per counterparty and role is drawn, with the newest disclosure winning within a tier; the table retains all underlying evidence. SVG draws the desktop/web diagram; the terminal uses braille, with native graphics when supported.

## Coverage and limitations

The schema supports listed and private companies and government entities globally, with separate country, exchange, identifiers and multilingual aliases. Ingestion follows available filings, issuer announcements, news text and management calls. EDGAR exhibits are a US source; issuer pages, releases and calls can cover companies anywhere. This is source-dependent coverage, not a claim that every exchange or every issuer is complete. The collection status and the dated evidence determine what is available.

Korean filing ingestion uses the official OpenDART API. The Japanese adapter uses EDINET API v2 and remains disabled until an API key is available; recorded public filing fixtures verify its parsing and display. Taiwan company identities come from official open data, while annual-report ingestion remains disabled pending a permitted official API source. No DART viewer, TWSE document-server or TDnet scraping is used. Global filing ingestion switches default off; an adapter's availability does not imply live or complete country coverage.

Country, exchange and identifiers remain separate from names. Korean `.KS`/`.KQ`, Japanese `.T` and Taiwanese `.TW`/`.TWO` listings retain their exchange identity. Coverage depends on each jurisdiction's disclosure rules: Korean reports often name customers together without individual percentages; Japanese major-customer tables may disclose entity or corporate-group amounts; Taiwanese reports commonly use anonymous A/B codes. Reverse disclosures can populate a company's view even while its home-country filing ingestion is disabled.

Unresolved names remain unresolved. Anonymous customer concentrations are never matched to a named company. Geographic, channel and customer cohorts are labelled **customer group** and never become company nodes or ribbons. Named corporate groups also remain distinct from listed company entities, have no tradable ticker and stay in Table and Evidence; their disclosures must not be attributed to a parent or subsidiary. An individually anonymous customer may appear in Flow. Annual reporting, disclosure thresholds, source availability and extraction throughput leave gaps. Absence is not proof of no relationship.

Verification can promote a lead when stronger evidence arrives. Conflicting values supersede rather than average: an earlier rumor cannot override a later filed amount. Unverified leads expire after 90 days; company/call evidence generally ages after 12 months and reporting after six months. Filing revisions follow the newer disclosure. Cached results are separated by account, entitlement and evidence selection, refreshed hourly and marked stale when refresh fails.

## CLI and REST

```sh
gloomberb fn SPLC NVDA --json
gloomberb fn SPLC 005930.KS --json
gloomberb fn SPLC NVDA --tiers sec,company,call,reported --json
gloomberb fn SPLC NVDA --tiers unconfirmed --json
gloomberb shot SPLC NVDA --tab table --view names --width 1280 --height 540 --output supply-table.png
gloomberb shot SPLC NVDA --tab flow --tiers sec,company,call,reported --width 720 --height 360 --output supply-flow.png
gloomberb shot SPLC NVDA --evidence --width 1280 --height 540 --output supply-evidence.png
```

The report preserves both directions, separate Unconfirmed sections, full-precision values, claim type, corroboration, lifecycle dates, evidence history and source links. Restricted quotes and glosses are null. `nativeAmount` is expressed in the disclosed units; multiply by `nativeScale` for units of `nativeCurrency`. `quoteLanguage`, `quoteGloss`, `quoteGlossKind`, `entityScope`, `jurisdiction`, `sectionRef` and `sourceAttribution` preserve global provenance. `quoteGlossKind` is `machine_translation` when a permitted gloss exists. Screenshots freeze and verify the same filtered payload and need no price feed.

The corresponding endpoint is `GET /cloud/supply-chain/:symbol?tiers=sec,company,call,reported`. Unconfirmed leads require `tiers=unconfirmed&includeLeads=1`; the app and CLI set the latter when Unconfirmed is selected. Omitting tiers defaults to Filings, Company and Call. The `sec` API and CLI filter token includes supported global regulatory filings as well as SEC filings. Account preview limits remain enforced by the server.
