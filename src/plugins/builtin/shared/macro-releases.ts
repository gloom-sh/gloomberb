/**
 * Macro releases people look for by a name no data series carries: the
 * purchasing managers' indexes and the GDP nowcasts. They are releases in the
 * economic calendar (ECO, `gloom econ`), with actual, forecast and prior, that
 * `alerts add` follows; GDPNow's history is also ECST's. `catalog` and
 * `search` answer a query that names one with `line`, and the data catalog's
 * empty search with `paneHint`, rather than with each other.
 */
interface MacroReleaseTopic {
  /** Runs of words that name it anywhere in a query ("pmi" in "ISM manufacturing PMI"). */
  phrases: readonly string[];
  /** Where it is, by the commands that list it and alert on it. */
  line: string;
  /** The same, by the functions the command bar opens. */
  paneHint: string;
}

const MACRO_RELEASE_TOPICS: readonly MacroReleaseTopic[] = [
  {
    phrases: ["pmi", "pmis", "ism", "purchasing manager", "purchasing managers", "purchasing managers index", "purchasing managers indexes", "caixin", "ratingdog"],
    line: "PMIs (ISM, S&P Global flash and final, NBS, RatingDog, formerly Caixin) are releases in the economic calendar: gloom econ, "
      + "or fn ECO --impact all (ECO opens on high impact only). An alert before one: gloom alerts add \"ISM Manufacturing PMI\". "
      + "No PMI series is charted; ECST has industrial production, durables and factory orders.",
    paneHint: "PMIs are releases in the economic calendar: ECO, Impact All. Industrial production and orders: ECST.",
  },
  {
    phrases: ["nowcast", "nowcasts", "nowcasting", "gdpnow", "gdp now"],
    line: "GDP nowcast: the Atlanta Fed's GDPNow, fn ECST gdpnow (history: gloom fred GDPNOW), the one nowcast series served. "
      + "Each update is a release in gloom econ --country US and fn ECO US --impact all; an alert before the next: "
      + "gloom alerts add \"Atlanta Fed GDPNow\".",
    paneHint: "GDPNow is in ECST, Nowcasts & conditions, and each update in ECO, Impact All.",
  },
];

/** The words of a text, lower case: "ISM-manufacturing" and "ism manufacturing" read alike. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function containsRun(query: readonly string[], run: readonly string[]): boolean {
  for (let at = 0; at + run.length <= query.length; at += 1) {
    if (run.every((word, index) => query[at + index] === word)) return true;
  }
  return false;
}

/** The macro release a query names ("flash PMI", "ISM services", "GDPNow"), else null. */
export function macroReleaseTopic(query: string): Pick<MacroReleaseTopic, "line" | "paneHint"> | null {
  const asked = words(query);
  if (asked.length === 0) return null;
  return MACRO_RELEASE_TOPICS.find((topic) => topic.phrases.some((phrase) => containsRun(asked, words(phrase)))) ?? null;
}

/**
 * Release series a sponsor renamed, by the name's old words and its new: the
 * S&P Global China PMI was Caixin's until RatingDog's from the August 2025
 * survey, and IHS Markit's PMIs are S&P Global's since 2022. A name typed
 * with the old words (`alerts add "Caixin PMI"`) reads as the series' current
 * name, and an alert kept under the old name follows the rows under the new.
 * Only renames of series the calendar lists.
 */
export const RENAMED_RELEASES: ReadonlyArray<{ former: readonly string[]; current: string; since: string }> = [
  { former: ["Caixin"], current: "RatingDog", since: "the August 2025 survey" },
  { former: ["IHS Markit", "Markit"], current: "S&P Global", since: "2022" },
];
