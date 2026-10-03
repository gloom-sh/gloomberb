# Supply chain disclosures

`SPLC NVDA` (or `SUPPLY NVDA`) opens the supply chain for a ticker. With no argument it uses the focused ticker. The pane follows linked tickers like other research functions.

The **Table** has two views. **NVDA says** reads NVIDIA's filings. **Names NVDA** reads other companies' filings that name NVIDIA. Role and direction are relative to the company in the pane title: suppliers flow in, customers flow out. A reverse percentage belongs to the company making the disclosure. For example, Cirrus Logic reporting Apple as 91% of revenue means 91% of Cirrus Logic's revenue, not Apple's. The evidence detail names the reporting company.

The columns keep the disclosed percentage and its denominator together: revenue, receivables, cost or purchases. A scoped percentage is marked **scoped**, with the full segment or product scope in evidence. It is not treated as a whole-company revenue percentage. Dollars are separately marked **disclosed** or **≈ derived**. Fiscal period, filing date, source type and confidence accompany each relationship. A missing number means it was not disclosed. Confidence describes extraction and entity resolution; it is not a probability of commercial success.

Select a row and press **Enter** to open the counterparty's SPLC. **E** shows its verbatim evidence and opens the filing. **D**, **F** and **G** open that counterparty's description, financial analysis and chart. Unresolved and anonymous entities open their evidence because they have no tradable ticker. **T** opens the existing TBO pane where that function is available; search there for the company. TBO has its own coverage and remains independent of SPLC.

## Flow

**Flow** places suppliers to the left, the focus company in the middle and customers to the right. Partners, competitors and investees occupy a separate bottom band. Color identifies role. Click a company or select it with Up/Down and press Enter to re-center; an unresolved company opens evidence. More than the available space allows is grouped under **+N more**. Activating that node pages through the entire band without squeezing labels together. A narrow pane falls back to the table.

Customer ribbon widths use revenue percentages disclosed by the focus company for the same fiscal period and scope. The largest compatible group sets the scale, preferring whole-company revenue on a tie; a segment scope appears above the customer band. Otherwise a band uses disclosed or derived dollars, labeled **Scale: USD**. Known positive values appear first in descending order and are proportional, with a fixed scale across pages. Unknown relationships use equal thin ribbons. Reverse percentages and percentages with a different period, scope or denominator remain thin when revenue percentages set the scale. The bands scale independently. They are not an accounting identity, and no percentages are summed. One most recent disclosure per counterparty and role is drawn; the table retains all underlying evidence. The active company's filing and percentage denominator appear above the flow. SVG draws the desktop/web diagram; the terminal uses braille, with native graphics when supported.

## Methodology and coverage

Phase 1 reads US filings. Counterparties can be listed or private companies anywhere, or government entities. Country, exchange and identifiers remain separate from names. Unresolved names are retained. Anonymous customer concentrations remain explicitly undisclosed and are never matched to a company. Geographic, channel and customer cohorts are labeled **Group:** in the table and identified as aggregate concentrations in evidence. These groups never become company nodes or ribbons in Flow. Individually anonymous customers can appear in Flow.

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
