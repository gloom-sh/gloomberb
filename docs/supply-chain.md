# Supply chain disclosures

`SPLC NVDA` (or `SUPPLY NVDA`) opens the supply chain for a ticker. With no argument it uses the focused ticker. The pane follows linked tickers like other research functions.

The **Table** has two views. **NVDA says** reads NVIDIA's filings. **Names NVDA** reads other companies' filings that name NVIDIA. Role and direction are relative to the company in the pane title: suppliers flow in, customers flow out. A reverse percentage belongs to the company making the disclosure. For example, Cirrus Logic reporting Apple as 91% of revenue means 91% of Cirrus Logic's revenue, not Apple's. The evidence detail names the reporting company.

A strip under the view switch names the company and counts the disclosed counterparties per role; a free account sees how many of them are shown.

**Share** keeps the disclosed percentage and its denominator together, in words: `of FY revenue`, `of quarterly revenue`, `of receivables`, `of cost of sales`, or the segment it is scoped to (`of Compute & Networking revenue`). A reverse share names the reporting company (`of CRUS revenue`). The bar beside it draws the percentage on a 0 to 100% scale in the role's colour. A scoped percentage is not treated as a whole-company revenue percentage; the full scope is in evidence. **Value** appears when a row discloses dollars, with derived amounts marked **≈**. Period, filing and confidence accompany each relationship; a narrow pane leaves the filing to evidence. A missing number means it was not disclosed. Confidence describes extraction and entity resolution; it is not a probability of commercial success.

Customers the filer does not name are labelled **undisclosed customer** (or supplier), and geographic, channel and customer cohorts **customer group**, both in muted text so they never read as a company.

Select a row and press **Enter** to open the counterparty's SPLC. **E** shows its verbatim evidence and opens the filing. **D**, **F** and **G** open that counterparty's description, financial analysis and chart. Unresolved and anonymous entities open their evidence because they have no tradable ticker. **T** opens the existing TBO pane where that function is available; search there for the company. TBO has its own coverage and remains independent of SPLC.

## Flow

**Flow** places suppliers to the left, the focus company in the middle and customers to the right. Each company is a card with its name, ticker and disclosed figure, edged in its role's colour; ribbons run from each card's edge to the focus company's edge and shade from one colour into the other. Partners, competitors and investees sit in a band underneath as ticker chips, one row per role, with cohort **Groups** listed as text beside them. Hover a card or ribbon to bring it forward and see the figure, its denominator, the period and the filing; Up/Down move the same highlight, and the selected relationship's filing and figure appear above the flow. Click a company or press Enter to open its own supply chain; an unresolved company opens evidence. More than the available space allows is grouped under **+N more**. Activating that node pages through the band without squeezing labels together. A narrow pane falls back to the table.

Customer ribbon widths use revenue percentages disclosed by the focus company for the same fiscal period and scope. The largest compatible group sets the scale, preferring whole-company revenue on a tie. Otherwise a column uses disclosed or derived dollars. A legend under the flow says what sets each column's widths. Known positive values appear first in descending order and are proportional, with a fixed scale across pages. Relationships with no comparable figure are hairlines. Reverse percentages and percentages with a different period, scope or denominator remain hairlines when revenue percentages set the scale. The columns scale independently. They are not an accounting identity, and no percentages are summed. One most recent disclosure per counterparty and role is drawn; the table retains all underlying evidence. SVG draws the desktop/web diagram; the terminal uses braille, with native graphics when supported.

## Methodology and coverage

Phase 1 reads US filings. Counterparties can be listed or private companies anywhere, or government entities. Country, exchange and identifiers remain separate from names. Unresolved names are retained. Anonymous customer concentrations remain explicitly undisclosed and are never matched to a company. Geographic, channel and customer cohorts are labeled **customer group** in the table and identified as aggregate concentrations in evidence. These groups never become company nodes or ribbons in Flow. Individually anonymous customers can appear in Flow.

Structured customer concentration disclosures and named relationships from filing text are separate source types. A text-extracted edge is accepted only when its evidence quote matches a literal substring of the filing after the requested text normalization. The validator records whether the original text matched exactly, matched with whitespace removed, or required Unicode NFKC normalization plus removal of all whitespace. The evidence detail shows that match mode and preserves the original quote. This validates evidence provenance; it does not alone prove that the relationship role was interpreted correctly. Item 1, risk factors, management discussion and concentration notes can have different reporting dates and scopes.

Reverse relationships are queries over the original disclosure, not additional stored facts. The direction can expose dependencies that the focus company does not name in its own filings. Annual reporting, concentration thresholds and varying disclosure practices leave substantial gaps. Disclosed in filings only. Absence is not proof of no relationship.

Free accounts receive the top three rows per role in each direction, including evidence. Pro receives all stored rows. This phase proposes that preview policy using the existing upgrade control. Public filings can be old; the pane shows the period and filing date rather than suggesting live coverage. Cached results are separated by account and entitlement, refreshed hourly, and marked stale when a refresh fails.

The schema is ready for additional jurisdictions and source languages. This release does not ingest non-US filings, calls, news, customs records or TBO data.

## CLI

```sh
gloomberb fn SPLC AAPL --json
gloomberb shot SPLC NVDA --tab table --view names --width 1280 --height 540 --output supply-table.png
gloomberb shot SPLC NVDA --tab flow --width 720 --height 360 --output supply-flow.png
```

The report contains both directions, full precision values, evidence quotes and filing links. Screenshots freeze the same disclosure payload they verify and need no price feed.
