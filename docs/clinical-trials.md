# Clinical trial search (TRIAL)

`TRIAL` searches the public ClinicalTrials.gov registry directly, every sponsor class, not only the industry studies the [catalyst calendar](catalysts.md) collects. The search box matches any part of a study record (condition, drug, sponsor, title), the registry's own search; it is not matched to tickers, so a company is found by its name, and a ticker typed as a search matches text, not the company. Studies are listed by the date the registry first posted them, newest first, and more load as you scroll until the registry has no more.

## Columns

Each study shows when it was posted, its phase, its overall status, its title, its lead sponsor and the sponsor's ticker. The title takes the room that is left; on a narrow pane the phase and status shorten (`Ph 2/3`, `Not yet` for not yet recruiting, `Active` for active, not recruiting) and the detail shows them in full, and on a pane narrower than a terminal the time column gives way to the title. `N/A` is the registry's "not applicable" phase (device and behavioural studies), `--` a study with no phase (observational).

The status is in the registry's words, coloured by stage: recruiting in green, not yet recruiting in a paler green, active or enrolling by invitation bright, completed dimmed, suspended amber, terminated and withdrawn red, unknown muted. The colours come from the theme, so they follow light and dark themes, and the words are always there. Industry sponsors read brighter than universities, hospitals and agencies.

## Filters

The query bar filters by status, phase and the lead sponsor's class (industry, NIH, U.S. federal, other government, network, individual, other: universities, hospitals and foundations). Filters are sent to the registry with the search, so every page that loads already matches them and paging never skips studies. They combine with the search and with each other, are saved with the pane like the search, and the pane menu (`.`) opens each one and clears them all. Opening the function with options sets them: `gloom shot TRIAL obesity --phase 3 --status recruiting --sponsor industry`.

## Tickers

The ticker is Gloom Cloud's answer for the lead sponsor's name, never a guess made in the app: the name has to match a company exactly (its own name, a legal-form variant such as Pfizer for Pfizer Inc., or a reviewed subsidiary name), and the company has to have a listing. A sponsor gets no ticker when it is not a listed company (universities, hospitals, NIH), when only a subsidiary or regional affiliate is named and no reviewed alias links it to its parent, and when the name fits more than one company (Merck): none is picked, and the detail says the name was ambiguous. Rows appear at once and tickers fill in as each page's sponsors are looked up. A `?` means the lookup did not happen (offline, or too many lookups at once); it is not an answer, and `r` asks again.

`d` opens the selected study's ticker in DES, and clicking the ticker, in the list or in the detail, does the same.

## Detail

Enter opens a study: its status, phase and study type, sponsor and class, ticker, registry ID, conditions, dates and enrollment, then the summary. `n` and `p` read on to the next and previous study, and `o` opens the study's registry page. `gloom shot TRIAL obesity --open NCT07868939` opens one study. Each date is as precise as the registry gives it (a month for many estimates), and `(est.)` marks a date the sponsor estimates rather than one that happened. Primary completion is when the last participant was examined for the primary outcome; neither it nor completion is a results, readout or approval date, and estimates move.
