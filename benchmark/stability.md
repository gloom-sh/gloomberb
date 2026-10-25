# Stability review

The initial comparison found 17 moving views at 23 widths. Every view also moved in at least one same-code repeat. Matching configuration/palette metadata and four-way image review found loading/enrichment or chart-render variation, with no additional unexplained layout movement. These states are excluded from the stable count; they are not verified unchanged.

Paired base-repeat/head-repeat comparisons fell below the 0.0005 native threshold at 17 of the 23 widths (16 returned zero changed pixels under the native comparator). Six widths remain above threshold. All comparisons use AE with 2% fuzz and exclude the top and bottom 42 pixels.

| View | Reviewed cause |
|---|---|
| ADJ--tab-rates | Loading history and no daily closes alternate within each revision. |
| ADR--tab-insider | Partial insider transaction pages, totals and loading state differ within each revision. |
| ADR--tab-sec | Filing summaries enrich asynchronously within each revision. |
| CORR--root | Loading/data completion; repeated before and after comparisons return zero changed pixels under the native comparator. |
| CTM--root | Loading/data completion; repeated before and after comparisons return zero changed pixels under the native comparator. |
| CTM--tab-markets | Quote fields progressively populate; repeated before and after comparisons return zero changed pixels under the native comparator. |
| HP--root | Loading/data completion; repeated before and after comparisons return zero changed pixels under the native comparator. |
| IPO--root | Original base shows Loading IPO calendar; populated repeat comparisons return zero changed pixels under the native comparator. |
| BI--tab-industries | Loading/data completion; repeated before and after comparisons return zero changed pixels under the native comparator. |
| FNG--root | Loading/data completion; repeated before and after comparisons return zero changed pixels under the native comparator. |
| GE--root | Loading/data completion; repeated before and after comparisons return zero changed pixels under the native comparator. |
| GIP--root | Original unavailable history transitions to populated chart; repeated before and after comparisons return zero changed pixels under the native comparator. |
| HVG--root | Original head lacks still-loading ATM IV reference; repeated before and after comparisons return zero changed pixels under the native comparator. |
| INS--root | Loading/data completion; repeated before and after comparisons return zero changed pixels under the native comparator. |
| new-portfolio-pane--tab-watchlist | Original head has pending Visa fundamentals; screenshot repeat comparisons return zero changed pixels under the native comparator despite earlier measurement timing. |
| OVDV--root | Same surface/data with axis label visibility and order variation within revisions. |
| OVDV--tab-term | Same values/curves with chart tick spacing and end-label variation within revisions. |

| View | Width | Original base/head | Base same-code | Head same-code | Paired repeats | Four-way sheet |
|---|---:|---:|---:|---:|---:|---|
| ADJ--tab-rates | 1280 | 0.103439% | 0.103439% | 0.103439% | 0.103439% | [sheet](stability/ADJ--tab-rates-1280.png) |
| ADR--tab-insider | 640 | 0.094928% | 26.339909% | 0.098202% | 26.341000% | [sheet](stability/ADR--tab-insider-640.png) |
| ADR--tab-insider | 1280 | 3.874171% | 0.043863% | 3.872643% | 0.000000% | [sheet](stability/ADR--tab-insider-1280.png) |
| ADR--tab-sec | 640 | 8.243715% | 2.279810% | 19.270688% | 13.306782% | [sheet](stability/ADR--tab-sec-640.png) |
| ADR--tab-sec | 1280 | 3.100013% | 1.292772% | 4.392785% | 0.000000% | [sheet](stability/ADR--tab-sec-1280.png) |
| CORR--root | 1280 | 8.971391% | 0.000000% | 8.971391% | 0.000000% | [sheet](stability/CORR--root-1280.png) |
| CTM--root | 640 | 30.018986% | 30.018986% | 0.000000% | 0.000000% | [sheet](stability/CTM--root-640.png) |
| CTM--tab-markets | 1280 | 4.567148% | 8.267720% | 3.700681% | 0.000000% | [sheet](stability/CTM--tab-markets-1280.png) |
| HP--root | 640 | 25.971980% | 25.971980% | 0.000000% | 0.000000% | [sheet](stability/HP--root-640.png) |
| IPO--root | 1280 | 95.066123% | 95.066123% | 0.000000% | 0.000000% | [sheet](stability/IPO--root-1280.png) |
| BI--tab-industries | 640 | 4.662622% | 0.000000% | 4.662622% | 0.000000% | [sheet](stability/BI--tab-industries-640.png) |
| BI--tab-industries | 1280 | 2.378994% | 0.000000% | 2.378994% | 0.000000% | [sheet](stability/BI--tab-industries-1280.png) |
| FNG--root | 640 | 1.707184% | 0.000000% | 1.707184% | 0.000000% | [sheet](stability/FNG--root-640.png) |
| GE--root | 640 | 44.742275% | 44.742275% | 0.000000% | 0.000000% | [sheet](stability/GE--root-640.png) |
| GIP--root | 1280 | 0.051938% | 15.344579% | 15.343815% | 0.000000% | [sheet](stability/GIP--root-1280.png) |
| HVG--root | 640 | 17.723027% | 0.000000% | 17.723027% | 0.000000% | [sheet](stability/HVG--root-640.png) |
| INS--root | 640 | 26.830918% | 26.830918% | 0.000000% | 0.000000% | [sheet](stability/INS--root-640.png) |
| INS--root | 1280 | 2.900227% | 2.900227% | 0.000000% | 0.000000% | [sheet](stability/INS--root-1280.png) |
| new-portfolio-pane--tab-watchlist | 1280 | 0.068741% | 0.000000% | 0.068741% | 0.000000% | [sheet](stability/new-portfolio-pane--tab-watchlist-1280.png) |
| OVDV--root | 640 | 0.700070% | 0.286749% | 0.818785% | 0.612779% | [sheet](stability/OVDV--root-640.png) |
| OVDV--root | 1280 | 0.329303% | 0.489809% | 0.018877% | 0.459584% | [sheet](stability/OVDV--root-1280.png) |
| OVDV--tab-term | 640 | 0.230010% | 0.174799% | 0.230883% | 0.192257% | [sheet](stability/OVDV--tab-term-640.png) |
| OVDV--tab-term | 1280 | 0.109440% | 0.072997% | 0.073979% | 0.032297% | [sheet](stability/OVDV--tab-term-1280.png) |

In the watchlist, Visa fundamentals were pending in one original screenshot; its paired repeat comparison returned zero changed pixels under the native comparator. Earlier DOM measurements can precede screenshot completion and do not override the pictured state. The fixture contains stocks and crypto, so this variation does not exercise the front-contract note. The targeted watchlist captures do.
