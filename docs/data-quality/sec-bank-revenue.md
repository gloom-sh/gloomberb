# Reported bank revenue in SEC history

Some banks report total net revenue under the US GAAP concept `RevenuesNetOfInterestExpense`. Omitting that concept left gaps in SEC-backed research history, including JPMorgan's first quarter of 2025 and all of Goldman Sachs' revenue. The SEC adapters now accept it as the last fallback for total revenue, after the existing revenue concepts. The reported amount already excludes interest expense; no further subtraction is applied.

Revenue concepts are chosen per period, so the fallback only applies while it measures the same thing as the filer's other revenue concepts. If any filing reports `RevenuesNetOfInterestExpense` and another revenue concept for the same period with different amounts, the fallback is dropped for that filer. American Express, for example, reports fee revenue alone under the contract-revenue concept; filling its empty quarters with total net revenue would create false jumps, so its series stays as reported. JPMorgan reports identical amounts under both concepts, so its missing quarters are filled.

The fallback requires USD observations and the existing SEC filing rules. A quarterly observation must cover 60 to 120 days, even when its source frame says it is a quarter, so six- and nine-month cumulative amounts cannot become individual quarters. Existing annual selection and the priority of other revenue concepts are unchanged. Each accepted value keeps its own filing availability date.

On current SEC data this adds revenue to 35 JPMorgan quarters, 42 Goldman Sachs quarters with 15 fiscal years, and 17 Wells Fargo quarters. Filers that report the concept with a different meaning (American Express, Morgan Stanley, Ameriprise, Jefferies, SoFi, Raymond James, Interactive Brokers, Northern Trust, Zions) and filers without it are unchanged.

Fourth quarters are not reported directly. Charts that use only SEC flows can derive a Q4 residual from the annual amount and Q1 to Q3, with derived provenance and availability at the annual filing; that does not create reported Q4 EPS or common income.
