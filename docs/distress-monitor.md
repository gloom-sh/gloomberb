# Distress records

`DIST` opens the M&A pane (`MA`) on its **Distress** tab: dated public records
about companies in difficulty, one list per source. The tab is free and needs
no account. The arrows (or a click) switch between the four sources; Enter
opens a record with its full text, source link and licence; `t` opens the
company's ticker when the record names one that trades; `o` opens the source
document.

The lists repeat what each source published, with its date. They contain no
scores, rankings or predictions, and none of them says how a company will fare.
A company missing from a list is not a finding: each source covers only some
companies, some forms and some time, and collection can lag or fail.

## 8-K

Current reports filed with the SEC under Item 1.03 (bankruptcy or
receivership) and Item 2.04 (a triggering event that accelerates or increases
a financial obligation). The **Items** filter switches to Item 3.01 notices
(a delisting, or a failure to meet a continued listing standard, which is
often a minimum bid price deficiency). Each list holds the 200 most recent
filings. The headline and summary are generated from the filing text; the
filing itself is the authoritative record. A filer with no trading symbol is
listed under its company name and CIK and offers no ticker.

## Going concern

Going-concern notes in 10-K and 10-Q filings, read from the SEC Financial
Statement and Notes data sets. Those data sets are published monthly, so a
note appears weeks after its filing; the footer names the latest month. Each
company appears once, for its latest filing that carries a going-concern note.
A later filing without the note does not mean the doubt was resolved.

The **Disclosure** filter starts on *Substantial doubt disclosed*: the filing
states substantial doubt about the company's ability to continue as a going
concern, and does not conclude that management's plans alleviate it. The
other readings are *Substantial doubt alleviated* (the filing concludes that
plans alleviate the doubt), *Policy text only* (the note describes the
assessment without disclosing doubt) and *Unclear*. The quote is the filing's
own sentence; the reading and summary are generated from the note text, and
the note in the filing governs. *Assessed over* is the period the filing says
its assessment covers, usually one year after the statements are issued; it is
not a date by which anything happens.

## Listings

Designations published by the Taiwan Stock Exchange and the Taipei Exchange:
delisted securities, securities the exchange moved to a changed trading
method, and suspended securities. A listing status is a fact about the
security, not a statement about the company's solvency: a merger can end a
listing too.

Only delistings carry an official date. For the other designations the
exchanges publish the current list without a designation date, so the **Date
basis** column says *First seen*: the day the row was first observed on the
exchange's list. A designation that leaves the list is marked as removed;
removal is not a statement that the company recovered. Delisted securities
offer no ticker.

## Insolvency

Company insolvency notices from the BODACC in France and The Gazette in the
United Kingdom, newest publication first. Notices about individuals are not
collected. **Procedure** groups notices into kinds (liquidation,
administration, claims notices and so on); **Notice** is the publisher's own
label: the French judgment label, or the Gazette notice title with its section
(*MVL* is a members' voluntary winding up, which a solvent company can use;
*CVL* is a creditors' voluntary winding up). A French notice can later be
rectified or cancelled, and the list shows that status. Search matches the
start of a company name. Notices are not linked to listed companies, so none
offers a ticker.

## Sources and licences

Every record links to its source. The detail view reproduces the licence each
source publishes under:

- 8-K filings and going-concern notes: SEC EDGAR filings and the SEC Financial
  Statement and Notes data sets.
- Taiwan listings: Financial Supervisory Commission, Securities and Futures
  Bureau; Taiwan Stock Exchange; Taipei Exchange. Open Government Data
  License, version 1.0 (data.gov.tw datasets 11543, 11760 and 11736).
- France: Direction de l'information légale et administrative (DILA), BODACC,
  under the Licence Ouverte / Open Licence 1.0.
- United Kingdom: The Gazette, under the Open Government Licence v3.0, Crown
  copyright. Personal data is excluded.

No source endorses Gloomberb.

## Command line

`gloomberb fn DIST` prints the same lists. `--view` picks the source
(`filings`, `going-concern`, `listings`, `insolvency`); `--items`,
`--verdict`, `--status`, `--exchange`, `--country`, `--procedure` and `--name`
narrow them as the tab's filters do. `gloomberb shot DIST --view listings`
saves a screenshot of one source.
